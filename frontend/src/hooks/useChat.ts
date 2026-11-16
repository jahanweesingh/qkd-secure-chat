import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildWebSocketUrl,
  normalizeMessage,
  normalizeParticipant,
  parseSocketPayload,
  readArray,
  readBoolean,
  readEventType,
  readString,
} from '../api';
import {
  createBb84StartCommand,
  normalizeBb84Result,
} from '../bb84';
import {
  decryptText,
  deriveContext,
  E2EE_KEY_ALGORITHM,
  E2EE_MESSAGE_ALGORITHM,
  E2EE_VERSION,
  encryptText,
  getOrCreateIdentity,
  isValidKeyIdentifier,
  isValidPublicKeyEnvelope,
  rotateIdentity,
} from '../e2ee';
import type { E2eeContext, E2eeIdentity } from '../e2ee';
import type {
  Bb84Config,
  Bb84Result,
  Bb84RunState,
} from '../bb84';
import type {
  ChatMessage,
  ChatSession,
  ConnectionInfo,
  EncryptionInfo,
  Participant,
  RoomSnapshot,
} from '../types';
import { MAX_MESSAGE_LENGTH } from '../types';
import { appendSecurityTrace, ciphertextTraceDetails, makeSecurityTraceEvent } from '../securityTrace';
import type { SecurityTraceDetail, SecurityTraceEvent, SecurityTraceKind } from '../securityTrace';

const MAX_RECONNECT_DELAY_MS = 8_000;
const TYPING_TTL_MS = 2_200;
const PING_INTERVAL_MS = 20_000;
const BB84_RESPONSE_TIMEOUT_MS = 10_000;
const VERIFICATION_STORAGE_PREFIX = 'qkd-chat-e2ee-verified';
const PEER_PIN_STORAGE_PREFIX = 'qkd-chat-e2ee-peer-pin';

const EMPTY_ENCRYPTION: EncryptionInfo = {
  state: 'idle',
  canSend: false,
  verificationCode: null,
  verifiedAt: null,
  peerName: null,
  localKeyId: null,
  peerKeyId: null,
  sessionKeyId: null,
  keyStorage: null,
  error: null,
};

function verificationStorageKey(roomId: string, keyId: string): string {
  return `${VERIFICATION_STORAGE_PREFIX}:${roomId}:${keyId}`;
}

function readVerification(roomId: string, keyId: string): string | null {
  try {
    return window.localStorage.getItem(verificationStorageKey(roomId, keyId));
  } catch {
    return null;
  }
}

function storeVerification(roomId: string, keyId: string, verifiedAt: string | null): void {
  try {
    const key = verificationStorageKey(roomId, keyId);
    if (verifiedAt) window.localStorage.setItem(key, verifiedAt);
    else window.localStorage.removeItem(key);
  } catch {
    // Verification remains valid for this page session when storage is blocked.
  }
}

function identityScope(session: ChatSession): string {
  return [
    E2EE_VERSION,
    session.roomCode,
    session.displayName.trim().toLocaleLowerCase(),
  ].join(':');
}

function peerPinStorageKey(session: ChatSession): string {
  return `${PEER_PIN_STORAGE_PREFIX}:${encodeURIComponent(identityScope(session))}`;
}

function readPeerPin(session: ChatSession): string | null {
  try {
    const value = window.localStorage.getItem(peerPinStorageKey(session));
    return value && isValidKeyIdentifier(value) ? value : null;
  } catch {
    return null;
  }
}

function storePeerPin(session: ChatSession, peerKeyId: string): void {
  if (!isValidKeyIdentifier(peerKeyId)) return;
  try {
    window.localStorage.setItem(peerPinStorageKey(session), peerKeyId);
  } catch {
    // Keep the in-memory pin active for this page when storage is blocked.
  }
}

function isTrustedBrowserOrigin(): boolean {
  if (window.isSecureContext) return true;
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

function newMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `message-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => {
    const delta = Date.parse(left.sentAt) - Date.parse(right.sentAt);
    return Number.isNaN(delta) ? 0 : delta;
  });
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const next = [...current];
  for (const message of incoming) {
    const optimisticIndex = message.clientMessageId
      ? next.findIndex(
          (item) => item.senderId === message.senderId
            && item.clientMessageId === message.clientMessageId,
        )
      : -1;
    const idIndex = next.findIndex((item) => item.id === message.id);
    const index = optimisticIndex >= 0 ? optimisticIndex : idIndex;
    if (index >= 0) {
      next[index] = { ...next[index], ...message, status: 'sent' };
    } else {
      next.push({ ...message, status: 'sent' });
    }
  }
  return sortMessages(next);
}

function mergeParticipant(current: Participant[], incoming: Participant): Participant[] {
  const existingIndex = current.findIndex((participant) => participant.id === incoming.id);
  if (existingIndex < 0) return [...current, incoming];
  return current.map((participant, index) =>
    index === existingIndex ? { ...participant, ...incoming } : participant,
  );
}

export interface ChatController {
  messages: ChatMessage[];
  participants: Participant[];
  typingNames: string[];
  connection: ConnectionInfo;
  encryption: EncryptionInfo;
  securityTrace: SecurityTraceEvent[];
  clearSecurityTrace: () => void;
  bb84Result: Bb84Result | null;
  bb84State: Bb84RunState;
  bb84Error: string | null;
  sendMessage: (text: string) => boolean;
  retryMessage: (id: string) => boolean;
  verifyEncryption: () => void;
  clearEncryptionVerification: () => void;
  acceptChangedKey: () => void;
  retryEncryption: () => void;
  runBb84: (config: Bb84Config) => boolean;
  setTyping: (isTyping: boolean) => void;
  reconnect: () => void;
}

export function useChat(
  session: ChatSession | null,
  initialSnapshot: RoomSnapshot,
): ChatController {
  const [messages, setMessages] = useState<ChatMessage[]>(initialSnapshot.messages);
  const [participants, setParticipants] = useState<Participant[]>(initialSnapshot.participants);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState<ConnectionInfo>({
    state: 'idle',
    attempt: 0,
    nextRetrySeconds: null,
    error: null,
  });
  const [encryption, setEncryption] = useState<EncryptionInfo>(EMPTY_ENCRYPTION);
  const [securityTrace, setSecurityTrace] = useState<SecurityTraceEvent[]>([]);
  const traceSequenceRef = useRef(0);
  const historicalMessagesRef = useRef(new WeakSet<ChatMessage>());
  const traceSentIdsRef = useRef(new Set<string>());
  const [bb84Result, setBb84Result] = useState<Bb84Result | null>(null);
  const [bb84State, setBb84State] = useState<Bb84RunState>('idle');
  const [bb84Error, setBb84Error] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const typingTimeoutsRef = useRef<Record<string, number>>({});
  const bb84StateRef = useRef<Bb84RunState>('idle');
  const bb84TimeoutRef = useRef<number | undefined>();
  const encryptionRef = useRef<EncryptionInfo>(EMPTY_ENCRYPTION);
  const identityRef = useRef<E2eeIdentity | null>(null);
  const identityPromiseRef = useRef<Promise<E2eeIdentity> | null>(null);
  const contextRef = useRef<E2eeContext | null>(null);
  const peerClientIdRef = useRef<string | null>(null);
  const contextsRef = useRef<Map<string, E2eeContext>>(new Map());
  const pendingEncryptedRef = useRef<Map<string, ChatMessage>>(new Map());
  const peerPinRef = useRef<string | null>(null);
  const identityRotationRequiredRef = useRef(false);
  const reverificationRequiredRef = useRef(false);
  const identityRotationPromiseRef = useRef<Promise<void> | null>(null);
  const sessionGenerationRef = useRef(0);

  const recordSecurityTrace = useCallback((
    kind: SecurityTraceKind,
    detail: Partial<SecurityTraceDetail> = {},
    generation = sessionGenerationRef.current,
  ) => {
    try {
      if (generation !== sessionGenerationRef.current) return;
      const event = makeSecurityTraceEvent(++traceSequenceRef.current, kind, detail);
      setSecurityTrace((current) => generation === sessionGenerationRef.current
        ? appendSecurityTrace(current, event) : current);
    } catch {
      // Observational UI is never allowed to change the crypto/send outcome.
    }
  }, []);
  const clearSecurityTrace = useCallback(() => setSecurityTrace([]), []);

  const updateEncryption = useCallback((
    update: EncryptionInfo | ((current: EncryptionInfo) => EncryptionInfo),
  ) => {
    setEncryption((current) => {
      const next = typeof update === 'function' ? update(current) : update;
      encryptionRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    sessionGenerationRef.current += 1;
    setSecurityTrace([]);
    traceSentIdsRef.current = new Set();
    const initialMessages = initialSnapshot.messages.map((message) =>
      message.encryption ? { ...message, text: 'Decrypting message…', security: 'decrypting' as const } : message,
    );
    historicalMessagesRef.current = new WeakSet(initialMessages);
    setMessages(initialMessages);
    pendingEncryptedRef.current = new Map(
      initialMessages
        .filter((message) => Boolean(message.encryption))
        .map((message) => [message.id, message]),
    );
    const withSelf = session
      ? mergeParticipant(initialSnapshot.participants, {
          id: session.clientId,
          name: session.displayName,
          online: true,
        })
      : initialSnapshot.participants;
    setParticipants(withSelf);
    setTypingUsers({});
    setBb84Result(null);
    setBb84State('idle');
    setBb84Error(null);
    contextRef.current = null;
    peerClientIdRef.current = null;
    contextsRef.current = new Map();
    identityRef.current = null;
    identityPromiseRef.current = null;
    peerPinRef.current = session ? readPeerPin(session) : null;
    identityRotationRequiredRef.current = false;
    reverificationRequiredRef.current = false;
    identityRotationPromiseRef.current = null;
    updateEncryption(session
      ? { ...EMPTY_ENCRYPTION, state: 'setting_up' }
      : EMPTY_ENCRYPTION);
    bb84StateRef.current = 'idle';
    window.clearTimeout(bb84TimeoutRef.current);
    bb84TimeoutRef.current = undefined;
  }, [initialSnapshot, session, updateEncryption]);

  useEffect(() => {
    if (!session) {
      setConnection({ state: 'idle', attempt: 0, nextRetrySeconds: null, error: null });
      return undefined;
    }

    const effectGeneration = sessionGenerationRef.current;
    let disposed = false;
    let retryAttempt = 0;
    let retryTimer: number | undefined;
    let countdownTimer: number | undefined;
    let pingTimer: number | undefined;
    let terminalError: string | null = null;
    let peerAdvertisementGeneration = 0;
    let processingMessage = false;
    let processingSocket: WebSocket | null = null;
    const messageQueue: Array<{ socket: WebSocket; payload: string }> = [];

    const observe = (
      kind: SecurityTraceKind,
      detail: Partial<SecurityTraceDetail> = {},
      expectedSocket = processingSocket ?? socketRef.current,
    ) => {
      if (!disposed && expectedSocket === socketRef.current) {
        recordSecurityTrace(kind, detail, effectGeneration);
      }
    };

    const clearTimers = () => {
      window.clearTimeout(retryTimer);
      window.clearInterval(countdownTimer);
      window.clearInterval(pingTimer);
    };

    const peerUnreachableMessage = () => {
      const hostLabel = session.roomHost ? ` at ${session.roomHost}` : '';
      return `The room host${hostLabel} could not be reached. Keep both Macs on the same private Wi-Fi, avoid guest or hotspot client isolation, allow Docker through the macOS firewall, and make sure the creator app is running.`;
    };

    const updateParticipants = (rawParticipants: unknown[]) => {
      const normalized = rawParticipants
        .map((participant, index) => normalizeParticipant(participant, index))
        .filter((participant): participant is Participant => participant !== null);
      setParticipants(
        mergeParticipant(normalized, {
          id: session.clientId,
          name: session.displayName,
          online: true,
        }),
      );
    };

    const failEncryption = (message: string, expectedSocket = processingSocket ?? socketRef.current) => {
      observe('encryption_failed', {}, expectedSocket);
      contextRef.current = null;
      updateEncryption((current) => ({
        ...current,
        state: 'failed',
        canSend: false,
        error: message,
      }));
    };

    const ensureIdentity = async (): Promise<E2eeIdentity> => {
      if (!isTrustedBrowserOrigin()) {
        throw new Error('Open this app through localhost on each Mac, or use HTTPS. Direct LAN HTTP cannot run trusted browser encryption.');
      }
      if (identityRef.current) return identityRef.current;
      const observationSocket = processingSocket ?? socketRef.current;
      if (!identityPromiseRef.current) {
        identityPromiseRef.current = getOrCreateIdentity(identityScope(session));
      }
      const identityPromise = identityPromiseRef.current;
      try {
        const identity = await identityPromise;
        if (disposed || effectGeneration !== sessionGenerationRef.current) {
          throw new Error('Encryption setup was superseded by another room session.');
        }
        identityRef.current = identity;
        observe('identity_ready', {}, observationSocket);
        updateEncryption((current) => ({
          ...current,
          localKeyId: identity.publicKeyId,
          keyStorage: identity.storage,
        }));
        return identity;
      } catch (error) {
        if (identityPromiseRef.current === identityPromise) {
          identityPromiseRef.current = null;
        }
        throw error;
      }
    };

    const decryptAndCommit = async (message: ChatMessage) => {
      const observationSocket = processingSocket ?? socketRef.current;
      const traceDetail: Partial<SecurityTraceDetail> = {
        messageId: message.clientMessageId,
        source: historicalMessagesRef.current.has(message) ? 'history' : 'live',
        direction: message.senderId === session.clientId ? 'outgoing' : 'incoming',
      };
      const payload = message.encryption;
      if (!payload || !message.clientMessageId) return;
      const context = contextsRef.current.get(payload.keyId);
      if (!context) {
        pendingEncryptedRef.current.set(message.id, message);
        if (contextRef.current) {
          pendingEncryptedRef.current.delete(message.id);
          setMessages((current) => mergeMessages(current, [{
            ...message,
            text: 'Encrypted message unavailable. This browser does not have its matching key.',
            security: 'unavailable',
          }]));
        }
        return;
      }
      try {
        const text = await decryptText(context, payload, {
          roomId: session.roomCode,
          senderId: message.senderId,
          senderName: message.senderName,
          clientMessageId: message.clientMessageId,
        });
        if (disposed) return;
        observe('message_decrypted', traceDetail, observationSocket);
        pendingEncryptedRef.current.delete(message.id);
        setMessages((current) => mergeMessages(current, [{
          ...message,
          text,
          security: 'encrypted',
        }]));
      } catch {
        if (disposed) return;
        observe('integrity_failed', traceDetail, observationSocket);
        pendingEncryptedRef.current.delete(message.id);
        setMessages((current) => mergeMessages(current, [{
          ...message,
          text: 'This encrypted message could not be authenticated.',
          security: 'unavailable',
        }]));
        if (contextRef.current?.keyId === payload.keyId) {
          failEncryption('A message failed its AES-GCM integrity check. Sending is paused; no unverified plaintext was shown.', observationSocket);
        }
      }
    };

    const settlePendingMessages = async (context: E2eeContext) => {
      const pending = [...pendingEncryptedRef.current.values()];
      for (const encryptedMessage of pending) {
        if (encryptedMessage.encryption?.keyId === context.keyId) {
          await decryptAndCommit(encryptedMessage);
        }
      }
      if (disposed || contextRef.current?.keyId !== context.keyId) return;

      const unavailableIds = new Set(
        [...pendingEncryptedRef.current.values()]
          .filter((message) => message.encryption?.keyId !== context.keyId)
          .map((message) => message.id),
      );
      if (unavailableIds.size === 0) return;
      for (const messageId of unavailableIds) {
        pendingEncryptedRef.current.delete(messageId);
      }
      setMessages((current) => current.map((message) => unavailableIds.has(message.id)
        ? {
            ...message,
            text: 'Earlier encrypted message unavailable. This browser does not have its matching key.',
            security: 'unavailable',
          }
        : message));
    };

    const processPeerAdvertisement = async (value: unknown) => {
      const observationSocket = processingSocket ?? socketRef.current;
      const advertisementGeneration = ++peerAdvertisementGeneration;
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      const peerClientId = readString(record, ['client_id', 'clientId']);
      const peerName = readString(record, ['display_name', 'displayName'], 'Room partner');
      const version = readString(record, ['version']);
      const algorithm = readString(record, ['algorithm']);
      const publicKey = readString(record, ['public_key', 'publicKey']);
      const publicKeyId = readString(record, ['public_key_id', 'publicKeyId']);
      if (peerClientId === session.clientId) return;
      if (
        version !== E2EE_VERSION
        || algorithm !== E2EE_KEY_ALGORITHM
        || !isValidPublicKeyEnvelope(publicKey, publicKeyId)
      ) {
        failEncryption('The partner sent an invalid encryption key advertisement.');
        return;
      }
      observe('peer_key_received', {}, observationSocket);
      try {
        const identity = await ensureIdentity();
        if (identity.publicKeyId === publicKeyId) return;
        const context = await deriveContext(
          identity,
          publicKey,
          publicKeyId,
          session.roomCode,
        );
        if (disposed || advertisementGeneration !== peerAdvertisementGeneration) return;
        const knownPeerKeyId = peerPinRef.current
          ?? readPeerPin(session)
          ?? encryptionRef.current.peerKeyId
          ?? contextRef.current?.peerPublicKeyId
          ?? null;
        const peerKeyChanged = Boolean(knownPeerKeyId && knownPeerKeyId !== publicKeyId);
        const keyChanged = peerKeyChanged || reverificationRequiredRef.current;
        observe('keys_derived', {}, observationSocket);
        if (keyChanged) observe('key_changed', {}, observationSocket);
        if (!knownPeerKeyId) {
          peerPinRef.current = publicKeyId;
          storePeerPin(session, publicKeyId);
        }
        contextRef.current = context;
        peerClientIdRef.current = peerClientId || peerClientIdRef.current;
        contextsRef.current.set(context.keyId, context);
        const verifiedAt = keyChanged ? null : readVerification(session.roomCode, context.keyId);
        updateEncryption({
          state: keyChanged
            ? 'key_changed'
            : verifiedAt
              ? 'encrypted_verified'
              : 'encrypted_unverified',
          canSend: !keyChanged,
          verificationCode: context.verificationCode,
          verifiedAt,
          peerName,
          localKeyId: context.localPublicKeyId,
          peerKeyId: context.peerPublicKeyId,
          sessionKeyId: context.keyId,
          keyStorage: identity.storage,
          error: keyChanged
            ? reverificationRequiredRef.current && !peerKeyChanged
              ? 'This browser rotated its encryption key after a repeated IV. Compare the new safety code before sending.'
              : 'The partner device key changed. Compare the new safety code before sending.'
            : null,
        });
        await settlePendingMessages(context);
      } catch (error) {
        if (disposed || advertisementGeneration !== peerAdvertisementGeneration) return;
        failEncryption(error instanceof Error && error.message.includes('localhost')
          ? error.message
          : 'The browser could not derive a matching encrypted session.', observationSocket);
      }
    };

    const advertiseIdentity = async (socket: WebSocket) => {
      updateEncryption((current) => ({
        ...current,
        state: 'setting_up',
        canSend: false,
        error: null,
      }));
      try {
        const identity = await ensureIdentity();
        if (disposed || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
          type: 'e2ee_hello',
          version: E2EE_VERSION,
          algorithm: E2EE_KEY_ALGORITHM,
          public_key_id: identity.publicKeyId,
          public_key: identity.publicKey,
        }));
        observe('public_key_sent', {}, socket);
        updateEncryption((current) => current.state === 'setting_up' ? ({
          ...current,
          state: 'waiting_for_peer',
          canSend: false,
          error: null,
        }) : current);
      } catch (error) {
        if (disposed || socketRef.current !== socket) return;
        failEncryption(error instanceof Error && error.message.includes('localhost')
          ? error.message
          : 'This browser could not create its private encryption key.');
      }
    };

    const handleMessage = async (rawPayload: string) => {
      const event = parseSocketPayload(rawPayload);
      if (!event) return;
      const type = readEventType(event);

      if (type === 'bb84_result') {
        window.clearTimeout(bb84TimeoutRef.current);
        bb84TimeoutRef.current = undefined;
        const result = normalizeBb84Result(event);
        if (!result) {
          bb84StateRef.current = 'error';
          setBb84State('error');
          setBb84Error('The simulation result could not be read. Please run the experiment again.');
          return;
        }
        bb84StateRef.current = 'complete';
        setBb84Result(result);
        setBb84State('complete');
        setBb84Error(null);
        return;
      }

      if (type === 'connected') {
        retryAttempt = 0;
        setConnection({ state: 'connected', attempt: 0, nextRetrySeconds: null, error: null });
        updateParticipants(readArray(event, ['participants', 'members']));
        const history = readArray(event, ['messages', 'history'])
          .map((item, index) => normalizeMessage(item, index))
          .filter((item): item is ChatMessage => item !== null);
        for (const message of history) {
          historicalMessagesRef.current.add(message);
          if (message.encryption) pendingEncryptedRef.current.set(message.id, message);
        }
        if (history.length > 0) setMessages((current) => mergeMessages(current, history));
        const liveSocket = socketRef.current;
        if (liveSocket) await advertiseIdentity(liveSocket);
        for (const advertisement of readArray(event, ['e2ee_public_keys'])) {
          await processPeerAdvertisement(advertisement);
        }
        return;
      }

      if (type === 'e2ee_public_key') {
        await processPeerAdvertisement(event);
        return;
      }

      if (type === 'message' || type === 'chat_message') {
        // The relay has no authenticated live system-message channel. Reject
        // every plaintext message event, including packets that merely label
        // themselves as "system", so a hostile relay cannot bypass E2EE by
        // changing a presentation field. Historical system notices are still
        // normalized separately when the initial room snapshot is loaded.
        failEncryption('An unauthenticated plaintext chat packet was received. It was hidden and sending is paused.');
        return;
      }

      if (type === 'encrypted_message') {
        const message = normalizeMessage(event);
        if (message) {
          setMessages((current) => mergeMessages(current, [message]));
          if (message.encryption) {
            observe('ciphertext_received', {
              ...ciphertextTraceDetails(message.encryption.ciphertext),
              messageId: message.clientMessageId,
              direction: message.senderId === session.clientId ? 'outgoing' : 'incoming',
            });
            pendingEncryptedRef.current.set(message.id, message);
            await decryptAndCommit(message);
          }
        }
        return;
      }

      if (type === 'message_ack' || type === 'ack') {
        const clientMessageId = readString(event, ['client_message_id', 'clientMessageId']);
        const serverId = readString(event, ['message_id', 'messageId', 'id']);
        const sentAt = readString(event, ['sent_at', 'sentAt']);
        if (clientMessageId) {
          if (traceSentIdsRef.current.has(clientMessageId)) {
            observe('relay_accepted', {
              messageId: clientMessageId, direction: 'outgoing',
              serverMessageId: serverId, serverSentAt: sentAt,
              duplicate: typeof event.duplicate === 'boolean' ? event.duplicate : undefined,
            });
          }
          setMessages((current) =>
            current.map((message) =>
              message.senderId === session.clientId && message.clientMessageId === clientMessageId
                ? {
                    ...message,
                    id: serverId || message.id,
                    sentAt: sentAt || message.sentAt,
                    status: 'sent',
                  }
                : message,
            ),
          );
          setConnection((current) => ({ ...current, error: null }));
        }
        return;
      }

      if (type === 'presence') {
        if (Array.isArray(event.participants) || Array.isArray(event.members)) {
          updateParticipants(readArray(event, ['participants', 'members']));
          return;
        }
        const rawParticipant = event.participant ?? event.user ?? event;
        const participant = normalizeParticipant(rawParticipant);
        if (!participant || participant.id === session.clientId) return;
        const action = readString(event, ['action', 'status']).toLowerCase();
        const online = action
          ? !['leave', 'left', 'offline', 'disconnected'].includes(action)
          : participant.online;
        setParticipants((current) => mergeParticipant(current, { ...participant, online }));
        if (!online && participant.id === peerClientIdRef.current) {
          peerAdvertisementGeneration += 1;
          contextRef.current = null;
          updateEncryption((current) => ({
            ...current,
            state: 'waiting_for_peer',
            canSend: false,
            error: 'Your partner disconnected. Sending will resume after their browser key returns.',
          }));
        }
        return;
      }

      if (type === 'typing') {
        const participantId = readString(event, [
          'client_id',
          'clientId',
          'sender_id',
          'user_id',
        ]);
        const participantName = readString(event, [
          'display_name',
          'displayName',
          'sender_name',
          'name',
        ]);
        if (!participantId || participantId === session.clientId || !participantName) return;
        window.clearTimeout(typingTimeoutsRef.current[participantId]);
        if (readBoolean(event, ['is_typing', 'isTyping'], false)) {
          setTypingUsers((current) => ({ ...current, [participantId]: participantName }));
          typingTimeoutsRef.current[participantId] = window.setTimeout(() => {
            setTypingUsers((current) => {
              const next = { ...current };
              delete next[participantId];
              return next;
            });
          }, TYPING_TTL_MS);
        } else {
          setTypingUsers((current) => {
            const next = { ...current };
            delete next[participantId];
            return next;
          });
        }
        return;
      }

      if (type === 'error') {
        const code = readString(event, ['code']).toLowerCase();
        let message = readString(event, ['message', 'detail'], 'The server rejected that action.');
        if (code === 'peer_unreachable') {
          message = peerUnreachableMessage();
        }
        if (code === 'invalid_room_code') {
          message = 'This invitation code does not contain a valid private IPv4 host address. Ask the room creator for a new code.';
        }
        if (code === 'origin_not_allowed') {
          message = 'This browser was refused by the chat server. Update and restart the project on both Macs, then try again.';
        }
        if ([
          'e2ee_not_ready',
          'e2ee_key_mismatch',
          'e2ee_public_key_conflict',
          'e2ee_required',
          'e2ee_iv_reuse',
        ].includes(code)) {
          if (code === 'e2ee_iv_reuse') {
            identityRotationRequiredRef.current = true;
            reverificationRequiredRef.current = true;
            contextsRef.current = new Map();
            peerAdvertisementGeneration += 1;
          }
          failEncryption(code === 'e2ee_key_mismatch'
            ? 'The room rejected a message because the active encryption keys changed. Sending is paused.'
            : code === 'e2ee_iv_reuse'
              ? 'The room detected a repeated AES-GCM IV. Sending is paused and the message was rejected.'
            : message);
        }
        if (
          bb84StateRef.current === 'running'
          && ['validation_error', 'bb84_busy', 'bb84_error'].includes(code)
        ) {
          window.clearTimeout(bb84TimeoutRef.current);
          bb84TimeoutRef.current = undefined;
          bb84StateRef.current = 'error';
          setBb84State('error');
          setBb84Error(code === 'validation_error'
            ? 'Those experiment settings were not accepted. Check each value and try again.'
            : message);
          return;
        }
        const clientMessageId = readString(event, ['client_message_id', 'clientMessageId']);
        if (clientMessageId) {
          if (traceSentIdsRef.current.has(clientMessageId)) {
            observe('message_failed', { messageId: clientMessageId, direction: 'outgoing' });
          }
          setMessages((current) => current.map((item) =>
            item.senderId === session.clientId && item.clientMessageId === clientMessageId
              ? {
                  ...item,
                  status: 'failed',
                  ...(code === 'e2ee_iv_reuse' ? { encryption: undefined } : {}),
                }
              : item,
          ));
        }
        if ([
          'room_full',
          'client_already_connected',
          'invalid_identity',
          'invalid_room_code',
          'origin_not_allowed',
          'peer_unreachable',
        ].includes(code)) {
          terminalError = message;
          setConnection((current) => ({ ...current, state: 'error', error: message }));
        } else {
          setConnection((current) => ({ ...current, error: message }));
        }
      }
    };

    const drainMessageQueue = () => {
      if (disposed || processingMessage) return;
      let queued = messageQueue.shift();
      while (queued && queued.socket !== socketRef.current) {
        queued = messageQueue.shift();
      }
      if (!queued) return;

      processingMessage = true;
      processingSocket = queued.socket;
      void handleMessage(queued.payload)
        .catch(() => {
          if (!disposed && socketRef.current === queued.socket) {
            setConnection((current) => ({
              ...current,
              error: 'An incoming real-time event could not be processed safely.',
            }));
          }
        })
        .finally(() => {
          processingMessage = false;
          processingSocket = null;
          drainMessageQueue();
        });
    };

    const scheduleReconnect = (openSocket: () => void) => {
      if (disposed) return;
      if (!navigator.onLine) {
        setConnection({
          state: 'offline',
          attempt: retryAttempt,
          nextRetrySeconds: null,
          error: 'This device is offline.',
        });
        return;
      }
      retryAttempt += 1;
      const delay = Math.min(1_000 * 2 ** (retryAttempt - 1), MAX_RECONNECT_DELAY_MS);
      const deadline = Date.now() + delay;
      setConnection({
        state: 'reconnecting',
        attempt: retryAttempt,
        nextRetrySeconds: Math.ceil(delay / 1_000),
        error: 'Connection interrupted. Messages are paused while we reconnect.',
      });
      window.clearInterval(countdownTimer);
      countdownTimer = window.setInterval(() => {
        setConnection((current) => ({
          ...current,
          nextRetrySeconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)),
        }));
      }, 250);
      retryTimer = window.setTimeout(() => {
        window.clearInterval(countdownTimer);
        openSocket();
      }, delay);
    };

    const openSocket = () => {
      if (disposed || !navigator.onLine) {
        setConnection({
          state: 'offline',
          attempt: retryAttempt,
          nextRetrySeconds: null,
          error: 'This device is offline.',
        });
        return;
      }
      setConnection({
        state: retryAttempt > 0 ? 'reconnecting' : 'connecting',
        attempt: retryAttempt,
        nextRetrySeconds: null,
        error: null,
      });
      const socket = new WebSocket(buildWebSocketUrl(session));
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (disposed) return;
        // Keep the UI in its connecting state until the application-level
        // `connected` event arrives. A relay socket can open locally before
        // the room host on the other Mac has accepted the connection.
        setConnection((current) => ({ ...current, error: null }));
        pingTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL_MS);
      });
      socket.addEventListener('message', (event: MessageEvent<string>) => {
        messageQueue.push({ socket, payload: event.data });
        drainMessageQueue();
      });
      socket.addEventListener('error', () => {
        if (!disposed) {
          setConnection((current) => ({
            ...current,
            error: 'The real-time connection could not be established.',
          }));
        }
      });
      socket.addEventListener('close', (event) => {
        if (disposed) return;
        if (socketRef.current !== socket) return;
        observe('connection_closed', {}, socket);
        window.clearInterval(pingTimer);
        peerAdvertisementGeneration += 1;
        socketRef.current = null;
        if (bb84StateRef.current === 'running') {
          window.clearTimeout(bb84TimeoutRef.current);
          bb84TimeoutRef.current = undefined;
          bb84StateRef.current = 'error';
          setBb84State('error');
          setBb84Error('The simulation was interrupted when the room connection closed. Reconnect and run it again.');
        }
        if (terminalError || [4003, 4400, 4403, 4409, 4410].includes(event.code)) {
          const fallbackMessage = event.code === 4410
            ? peerUnreachableMessage()
            : event.code === 4400
              ? 'This invitation code is invalid. Ask the room creator for a new code.'
              : 'This room already has two participants.';
          setConnection({
            state: 'error',
            attempt: retryAttempt,
            nextRetrySeconds: null,
            error: terminalError
              || ([4400, 4410].includes(event.code) ? fallbackMessage : event.reason || fallbackMessage),
          });
          return;
        }
        scheduleReconnect(openSocket);
      });
    };

    const handleOffline = () => {
      setConnection({
        state: 'offline',
        attempt: retryAttempt,
        nextRetrySeconds: null,
        error: 'This device is offline.',
      });
      socketRef.current?.close();
    };
    const handleOnline = () => {
      clearTimers();
      retryAttempt = 0;
      openSocket();
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    openSocket();

    return () => {
      disposed = true;
      peerAdvertisementGeneration += 1;
      messageQueue.length = 0;
      clearTimers();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      Object.values(typingTimeoutsRef.current).forEach((timeout) => window.clearTimeout(timeout));
      typingTimeoutsRef.current = {};
      window.clearTimeout(bb84TimeoutRef.current);
      bb84TimeoutRef.current = undefined;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Client left room');
    };
  }, [reconnectToken, session, updateEncryption, recordSecurityTrace]);

  const transmitMessage = useCallback(
    (message: ChatMessage): boolean => {
      const observationGeneration = sessionGenerationRef.current;
      const socket = socketRef.current;
      const context = contextRef.current;
      if (
        !session
        || !message.clientMessageId
        || !socket
        || socket.readyState !== WebSocket.OPEN
        || !context
        || !encryptionRef.current.canSend
      ) return false;

      const sendEnvelope = (payload: NonNullable<ChatMessage['encryption']>) => {
        socket.send(JSON.stringify({
          type: 'encrypted_message',
          client_message_id: message.clientMessageId,
          version: payload.version,
          algorithm: payload.algorithm,
          key_id: payload.keyId,
          iv: payload.iv,
          ciphertext: payload.ciphertext,
        }));
        if (socketRef.current === socket) {
          traceSentIdsRef.current.add(message.clientMessageId!);
          if (traceSentIdsRef.current.size > 128) {
            traceSentIdsRef.current.delete(traceSentIdsRef.current.values().next().value!);
          }
          recordSecurityTrace('ciphertext_sent', {
            ...ciphertextTraceDetails(payload.ciphertext),
            messageId: message.clientMessageId,
            direction: 'outgoing',
          }, observationGeneration);
        }
      };

      if (
        message.encryption
        && message.encryption.keyId === context.keyId
        && message.encryption.senderKeyId === context.localPublicKeyId
      ) {
        try {
          sendEnvelope(message.encryption);
          return true;
        } catch {
          recordSecurityTrace('message_failed', {
            messageId: message.clientMessageId, direction: 'outgoing',
          }, observationGeneration);
          return false;
        }
      }

      void encryptText(context, message.text, {
        roomId: session.roomCode,
        senderId: session.clientId,
        senderName: session.displayName,
        clientMessageId: message.clientMessageId,
      }).then((payload) => {
        if (
          contextRef.current !== context
          || !encryptionRef.current.canSend
          || socketRef.current !== socket
          || socket.readyState !== WebSocket.OPEN
        ) {
          setMessages((current) => current.map((item) =>
            item.clientMessageId === message.clientMessageId
              ? { ...item, status: 'failed' }
              : item,
          ));
          return;
        }
        recordSecurityTrace('message_encrypted', {
          ...ciphertextTraceDetails(payload.ciphertext),
          messageId: message.clientMessageId,
          direction: 'outgoing',
        }, observationGeneration);
        const encryptionPayload: NonNullable<ChatMessage['encryption']> = {
          ...payload,
          algorithm: E2EE_MESSAGE_ALGORITHM,
        };
        setMessages((current) => current.map((item) =>
          item.clientMessageId === message.clientMessageId
            ? { ...item, encryption: encryptionPayload, security: 'encrypted' }
            : item,
        ));
        sendEnvelope(encryptionPayload);
      }).catch((error: unknown) => {
        if (socketRef.current === socket) {
          recordSecurityTrace('message_failed', {
            messageId: message.clientMessageId, direction: 'outgoing',
          }, observationGeneration);
        }
        const detail = error instanceof Error ? error.message : '';
        const ivGenerationFailed = detail.includes('unique AES-GCM IV');
        if (ivGenerationFailed) {
          identityRotationRequiredRef.current = true;
          reverificationRequiredRef.current = true;
          contextRef.current = null;
          contextsRef.current = new Map();
        }
        setMessages((current) => current.map((item) =>
          item.clientMessageId === message.clientMessageId
            ? { ...item, status: 'failed' }
            : item,
        ));
        setConnection((current) => ({
          ...current,
          error: detail.includes('1-4096 bytes')
            ? 'That message is too large after UTF-8 encoding.'
            : 'The message could not be encrypted and was not sent.',
        }));
        if (!detail.includes('1-4096 bytes')) {
          contextRef.current = null;
          updateEncryption((current) => ({
            ...current,
            state: 'failed',
            canSend: false,
            error: ivGenerationFailed
              ? 'The browser repeated an AES-GCM IV. Sending is paused until a fresh encryption identity is created.'
              : 'The browser encryption operation failed. No plaintext was sent.',
          }));
        }
      });
      return true;
    },
    [session, updateEncryption, recordSecurityTrace],
  );

  const sendMessage = useCallback(
    (text: string): boolean => {
      const cleanText = text.trim();
      if (!session || !cleanText || cleanText.length > MAX_MESSAGE_LENGTH) return false;
      setConnection((current) => ({ ...current, error: null }));
      const clientMessageId = newMessageId();
      const message: ChatMessage = {
        id: `pending-${clientMessageId}`,
        clientMessageId,
        senderId: session.clientId,
        senderName: session.displayName,
        text: cleanText,
        sentAt: new Date().toISOString(),
        kind: 'message',
        status: 'sending',
        security: 'encrypted',
      };
      setMessages((current) =>
        mergeMessages(current, [message]).map((item) =>
          item.clientMessageId === clientMessageId ? { ...item, status: 'sending' } : item,
        ),
      );
      const sent = transmitMessage(message);
      if (!sent) {
        setMessages((current) =>
          current.map((item) =>
            item.clientMessageId === clientMessageId ? { ...item, status: 'failed' } : item,
          ),
        );
      }
      return sent;
    },
    [session, transmitMessage],
  );

  const retryMessage = useCallback(
    (id: string): boolean => {
      const message = messages.find((item) => item.id === id);
      if (!message) return false;
      setConnection((current) => ({ ...current, error: null }));
      const sent = transmitMessage(message);
      setMessages((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: sent ? 'sending' : 'failed' } : item,
        ),
      );
      return sent;
    },
    [messages, transmitMessage],
  );

  const verifyEncryption = useCallback(() => {
    const context = contextRef.current;
    if (!session || !context) return;
    const verifiedAt = new Date().toISOString();
    peerPinRef.current = context.peerPublicKeyId;
    storePeerPin(session, context.peerPublicKeyId);
    reverificationRequiredRef.current = false;
    storeVerification(session.roomCode, context.keyId, verifiedAt);
    updateEncryption((current) => ({
      ...current,
      state: 'encrypted_verified',
      canSend: true,
      verifiedAt,
      error: null,
    }));
  }, [session, updateEncryption]);

  const clearEncryptionVerification = useCallback(() => {
    const context = contextRef.current;
    if (!session || !context) return;
    storeVerification(session.roomCode, context.keyId, null);
    updateEncryption((current) => ({
      ...current,
      state: 'encrypted_unverified',
      canSend: true,
      verifiedAt: null,
      error: null,
    }));
  }, [session, updateEncryption]);

  const acceptChangedKey = useCallback(() => {
    const context = contextRef.current;
    if (!session || !context || encryptionRef.current.state !== 'key_changed') return;
    peerPinRef.current = context.peerPublicKeyId;
    storePeerPin(session, context.peerPublicKeyId);
    reverificationRequiredRef.current = false;
    storeVerification(session.roomCode, context.keyId, null);
    updateEncryption((current) => ({
      ...current,
      state: 'encrypted_unverified',
      canSend: true,
      verifiedAt: null,
      error: null,
    }));
  }, [session, updateEncryption]);

  const retryEncryption = useCallback(() => {
    if (identityRotationRequiredRef.current) {
      if (!session || identityRotationPromiseRef.current) return;
      const generation = sessionGenerationRef.current;
      updateEncryption((current) => ({
        ...current,
        state: 'setting_up',
        canSend: false,
        verificationCode: null,
        verifiedAt: null,
        sessionKeyId: null,
        error: null,
      }));

      const rotation = rotateIdentity(identityScope(session))
        .then((identity) => {
          if (generation !== sessionGenerationRef.current) return;
          identityRef.current = identity;
          recordSecurityTrace('identity_ready', {}, generation);
          identityPromiseRef.current = Promise.resolve(identity);
          contextRef.current = null;
          contextsRef.current = new Map();
          identityRotationRequiredRef.current = false;
          reverificationRequiredRef.current = true;
          updateEncryption((current) => ({
            ...current,
            state: 'setting_up',
            canSend: false,
            verificationCode: null,
            verifiedAt: null,
            localKeyId: identity.publicKeyId,
            sessionKeyId: null,
            keyStorage: identity.storage,
            error: null,
          }));
          setReconnectToken((value) => value + 1);
        })
        .catch(() => {
          if (generation !== sessionGenerationRef.current) return;
          updateEncryption((current) => ({
            ...current,
            state: 'failed',
            canSend: false,
            error: 'This browser could not rotate its encryption identity. Sending remains paused.',
          }));
        })
        .finally(() => {
          if (identityRotationPromiseRef.current === rotation) {
            identityRotationPromiseRef.current = null;
          }
        });
      identityRotationPromiseRef.current = rotation;
      return;
    }

    const socket = socketRef.current;
    const identity = identityRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !identity) {
      setReconnectToken((value) => value + 1);
      return;
    }
    const existingContext = encryptionRef.current.sessionKeyId
      ? contextsRef.current.get(encryptionRef.current.sessionKeyId) ?? null
      : null;
    contextRef.current = existingContext;
    updateEncryption((current) => ({
      ...current,
      state: 'setting_up',
      canSend: false,
      error: null,
    }));
    try {
      socket.send(JSON.stringify({
        type: 'e2ee_hello',
        version: E2EE_VERSION,
        algorithm: E2EE_KEY_ALGORITHM,
        public_key_id: identity.publicKeyId,
        public_key: identity.publicKey,
      }));
      recordSecurityTrace('public_key_sent');
      const verifiedAt = existingContext && session
        ? readVerification(session.roomCode, existingContext.keyId)
        : null;
      updateEncryption((current) => existingContext ? ({
        ...current,
        state: verifiedAt ? 'encrypted_verified' : 'encrypted_unverified',
        canSend: true,
        verifiedAt,
        error: null,
      }) : ({ ...current, state: 'waiting_for_peer' }));
    } catch {
      updateEncryption((current) => ({
        ...current,
        state: 'failed',
        error: 'The encryption setup request could not be sent.',
      }));
    }
  }, [session, updateEncryption, recordSecurityTrace]);

  const runBb84 = useCallback((config: Bb84Config): boolean => {
    const socket = socketRef.current;
    if (!session || !socket || socket.readyState !== WebSocket.OPEN) {
      bb84StateRef.current = 'error';
      setBb84State('error');
      setBb84Error('Connect to the room before running the BB84 experiment.');
      return false;
    }
    try {
      socket.send(JSON.stringify(createBb84StartCommand(config)));
      window.clearTimeout(bb84TimeoutRef.current);
      bb84StateRef.current = 'running';
      setBb84State('running');
      setBb84Error(null);
      setBb84Result(null);
      bb84TimeoutRef.current = window.setTimeout(() => {
        if (bb84StateRef.current !== 'running') return;
        bb84StateRef.current = 'error';
        bb84TimeoutRef.current = undefined;
        setBb84State('error');
        setBb84Error('The simulation did not return a result within 10 seconds. Check the room connection and try again.');
      }, BB84_RESPONSE_TIMEOUT_MS);
      return true;
    } catch {
      bb84StateRef.current = 'error';
      setBb84State('error');
      setBb84Error('The experiment could not be sent. Reconnect and try again.');
      return false;
    }
  }, [session]);

  const setTyping = useCallback((isTyping: boolean) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'typing', is_typing: isTyping }));
  }, []);

  const reconnect = useCallback(() => {
    socketRef.current?.close(1000, 'Manual reconnect');
    setReconnectToken((value) => value + 1);
  }, []);

  const typingNames = useMemo(() => Object.values(typingUsers), [typingUsers]);

  return {
    messages,
    participants,
    typingNames,
    connection,
    encryption,
    securityTrace,
    clearSecurityTrace,
    bb84Result,
    bb84State,
    bb84Error,
    sendMessage,
    retryMessage,
    verifyEncryption,
    clearEncryptionVerification,
    acceptChangedKey,
    retryEncryption,
    runBb84,
    setTyping,
    reconnect,
  };
}
