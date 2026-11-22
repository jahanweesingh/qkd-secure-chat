import { useRef } from 'react';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolLab, SecurityPanel } from './App';
import { MockWebSocket } from './test/MockWebSocket';
import type { ChatController } from './hooks/useChat';
import { useChat } from './hooks/useChat';
import type { ChatSession, RoomSnapshot } from './types';

const emptySnapshot: RoomSnapshot = { messages: [], participants: [] };
const roomId = 'RENDERED-SECURITY-ROOM';

function session(clientId: string, displayName: string): ChatSession {
  return { clientId, displayName, roomCode: roomId, roomRoute: 'local', roomHost: null };
}

function ActualAliceSecurityViews({ chatSession, capture }: {
  chatSession: ChatSession;
  capture: (controller: ChatController) => void;
}) {
  const chat = useChat(chatSession, emptySnapshot);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  capture(chat);
  return <>
    <SecurityPanel open encryption={chat.encryption} endpointBb84={chat.endpointBb84}
      onClose={vi.fn()} onVerify={chat.verifyEncryption} onClearVerification={chat.clearEncryptionVerification}
      onAcceptChangedKey={chat.acceptChangedKey} onRetry={chat.retryEncryption} />
    <ProtocolLab open encryption={chat.encryption} connection={chat.connection} participants={chat.participants}
      currentClientId={chatSession.clientId} result={chat.bb84Result} state={chat.bb84State} error={chat.bb84Error}
      returnFocusRef={returnFocusRef} onRun={chat.runBb84} endpointBb84={chat.endpointBb84}
      onStartEndpointBb84={chat.startEndpointBb84} onUseEcdhFallback={chat.useEcdhFallback} onClose={vi.fn()} />
  </>;
}

describe('rendered Security Details and BB84 Lab follow the live chat encryption context', () => {
  beforeEach(() => {
    window.localStorage.clear();
    MockWebSocket.reset();
    vi.stubGlobal('WebSocket', MockWebSocket);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('renders the actual ECDH mode, then hybrid activation and ECDH fallback from a two-endpoint BB84 run', async () => {
    const aliceSession = session('rendered-alice', 'Alice');
    const bobSession = session('rendered-bob', 'Bob');
    let alice!: ChatController;
    render(<ActualAliceSecurityViews chatSession={aliceSession} capture={controller => { alice = controller; }} />);
    const aliceSocket = MockWebSocket.instances.at(-1)!;
    const bobHook = renderHook(() => useChat(bobSession, emptySnapshot));
    const bobSocket = MockWebSocket.instances.at(-1)!;
    MockWebSocket.onSend = (source, raw) => {
      const packet = JSON.parse(raw) as Record<string, unknown>;
      if (packet.type === 'bb84_control') {
        queueMicrotask(() => (source === aliceSocket ? bobSocket : aliceSocket).receive(packet));
      }
    };

    act(() => {
      aliceSocket.open();
      aliceSocket.receive({ type: 'connected', room_id: roomId, participants: [], messages: [] });
      bobSocket.open();
      bobSocket.receive({ type: 'connected', room_id: roomId, participants: [], messages: [] });
    });
    await waitFor(() => {
      expect(aliceSocket.sent.some(raw => JSON.parse(raw).type === 'e2ee_hello')).toBe(true);
      expect(bobSocket.sent.some(raw => JSON.parse(raw).type === 'e2ee_hello')).toBe(true);
    });
    const aliceHello = aliceSocket.sent.map(raw => JSON.parse(raw) as Record<string, unknown>).find(packet => packet.type === 'e2ee_hello')!;
    const bobHello = bobSocket.sent.map(raw => JSON.parse(raw) as Record<string, unknown>).find(packet => packet.type === 'e2ee_hello')!;
    act(() => {
      aliceSocket.receive({ type: 'e2ee_public_key', client_id: bobSession.clientId, display_name: 'Bob', version: 'e2ee-v1', algorithm: 'ECDH-P256', public_key: bobHello.public_key, public_key_id: bobHello.public_key_id });
      bobSocket.receive({ type: 'e2ee_public_key', client_id: aliceSession.clientId, display_name: 'Alice', version: 'e2ee-v1', algorithm: 'ECDH-P256', public_key: aliceHello.public_key, public_key_id: aliceHello.public_key_id });
    });
    await waitFor(() => expect(alice.encryption.activeKeyMode).toBe('ecdh'));

    const securityDialog = within(screen.getByRole('dialog', { name: 'Security details' }));
    const labDialog = within(screen.getByRole('dialog', { name: 'BB84 Security Lab' }));
    const people = within(labDialog.getByLabelText('People in the simulation'));
    expect(people.getByText('Alice').closest('.lab-person')).toHaveClass('lab-person--alice');
    expect(people.getByText('Bob').closest('.lab-person')).toHaveClass('lab-person--bob');
    expect(people.getByText('Eve').closest('.lab-person')).toHaveClass('lab-person--eve');
    await userClick(securityDialog.getByText('Technical details'));
    expect(securityDialog.getByRole('region', { name: 'Endpoint BB84 and chat key status' })).toHaveTextContent('Chat encryptionECDH-only');
    expect(labDialog.getByText('ECDH-only chat active')).toBeVisible();
    expect(labDialog.getByLabelText('BB84 sample error rate')).toHaveTextContent('Waiting for sample');
    expect(labDialog.queryByRole('status', { name: 'Current chat security' })).not.toBeInTheDocument();

    act(() => {
      expect(alice.startEndpointBb84({ qubitCount: 512, noiseProbability: 0, interceptProbability: 0, sampleRatio: 0.25, qberThreshold: 0.11, seed: null })).toBe(true);
    });
    await waitFor(() => {
      expect(alice.encryption.activeKeyMode).toBe('bb84_hybrid');
      expect(bobHook.result.current.encryption.activeKeyMode).toBe('bb84_hybrid');
    }, { timeout: 15_000 });
    const activeDetails = securityDialog.getByRole('region', { name: 'Endpoint BB84 and chat key status' });
    expect(activeDetails).toHaveTextContent('Chat encryptionBB84-ECDH hybrid active');
    expect(activeDetails).toHaveTextContent('BB84 key contributionConfirmed');
    expect(activeDetails).toHaveTextContent('Contribution in chat encryptionActive in hybrid epoch');
    expect(activeDetails).toHaveTextContent('Mutual key confirmationConfirmed');
    expect(screen.getByText(/ECDH shared secret \+ confirmed BB84 contribution → HKDF-SHA-256 → separate directional AES-256-GCM keys/)).toBeVisible();
    expect(labDialog.getByText('Hybrid key active')).toBeVisible();
    expect(labDialog.getByLabelText('BB84 sample error rate')).toHaveTextContent('0.00%');
    expect(labDialog.getByText('Hybrid chat key active')).toBeVisible();
    const establishmentSteps = within(labDialog.getByRole('list', { name: 'Endpoint BB84 establishment steps' }));
    expect(establishmentSteps.getAllByRole('listitem')).toHaveLength(7);
    for (const step of ['State Preparation', 'Measurement', 'Basis Reconciliation', 'QBER Analysis', 'Error Correction', 'Privacy Amplification', 'Key Confirmation']) {
      expect(establishmentSteps.getByText(step)).toBeVisible();
    }
    expect(labDialog.getAllByRole('progressbar')).toHaveLength(1);

    await userClick(labDialog.getByRole('button', { name: 'Switch chat back to ECDH' }));
    expect(alice.encryption.activeKeyMode).toBe('ecdh');
    expect(activeDetails).toHaveTextContent('Chat encryptionECDH-only');
    expect(activeDetails).toHaveTextContent('Active hybrid epochNot active');
    expect(labDialog.getByText('ECDH-only chat active')).toBeVisible();
    expect(labDialog.getByText('BB84 completed · ECDH fallback active')).toBeVisible();
    bobHook.unmount();
  });
});

async function userClick(element: HTMLElement) {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.setup().click(element);
}
