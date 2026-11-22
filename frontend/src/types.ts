export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'error';

export const MAX_MESSAGE_LENGTH = 2_000;

export type MessageStatus = 'sending' | 'sent' | 'failed';

export type MessageSecurity =
  | 'encrypted'
  | 'legacy_plaintext'
  | 'decrypting'
  | 'unavailable';

export interface EncryptedMessageData {
  version: 'e2ee-v1';
  algorithm: 'AES-256-GCM';
  keyId: string;
  senderKeyId: string;
  iv: string;
  ciphertext: string;
}

export interface ChatMessage {
  id: string;
  clientMessageId?: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: string;
  kind: 'message' | 'system';
  status?: MessageStatus;
  security?: MessageSecurity;
  encryption?: EncryptedMessageData;
}

export interface Participant {
  id: string;
  name: string;
  online: boolean;
  joinedAt?: string;
}

export interface ChatSession {
  clientId: string;
  displayName: string;
  roomCode: string;
  roomRoute: 'local' | 'host' | 'partner';
  roomHost: string | null;
}

export interface RoomSnapshot {
  messages: ChatMessage[];
  participants: Participant[];
  e2eeRequired?: boolean;
}

export interface JoinRoomInput {
  displayName: string;
  roomCode?: string;
  mode?: 'create' | 'join';
}

export interface JoinRoomResult extends ChatSession, RoomSnapshot {}

export interface ConnectionInfo {
  state: ConnectionState;
  attempt: number;
  nextRetrySeconds: number | null;
  error: string | null;
}

export type NetworkStatus = {
  mode: 'lan' | 'localhost';
  advertisedHost: string | null;
  port: number;
  ready: boolean;
} | {
  mode: 'hosted';
  advertisedHost: null;
  port: number;
  ready: true;
};

export type EncryptionState =
  | 'idle'
  | 'setting_up'
  | 'waiting_for_peer'
  | 'encrypted_unverified'
  | 'encrypted_verified'
  | 'key_changed'
  | 'failed';

export interface EncryptionInfo {
  state: EncryptionState;
  canSend: boolean;
  activeKeyMode: 'ecdh' | 'bb84_hybrid' | null;
  verificationCode: string | null;
  verifiedAt: string | null;
  peerName: string | null;
  localKeyId: string | null;
  peerKeyId: string | null;
  sessionKeyId: string | null;
  keyStorage: 'device' | 'session' | null;
  error: string | null;
}
