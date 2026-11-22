import { describe, expect, it } from 'vitest';
import { computePairKeyId, deriveBb84ControlKeys, generateIdentity } from './e2ee';
import { Bb84ControlReceiver, Bb84ControlSender } from './bb84Control';
import { EndpointBb84ChatSession } from './bb84ChatSession';

async function runTwoEndpointExchange(interceptPpm: number) {
  const [aliceIdentity, bobIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
  const roomId = 'endpoint-demo';
  const pairKeyId = await computePairKeyId(roomId, aliceIdentity.publicKey, bobIdentity.publicKey);
  const runId = crypto.getRandomValues(new Uint8Array(16));
  const [aliceKeys, bobKeys] = await Promise.all([
    deriveBb84ControlKeys(aliceIdentity, bobIdentity.publicKey, roomId, pairKeyId, runId),
    deriveBb84ControlKeys(bobIdentity, aliceIdentity.publicKey, roomId, pairKeyId, runId),
  ]);
  const aliceSender = new Bb84ControlSender(aliceKeys, {
    roomId, pairKeyId, senderKeyId: aliceIdentity.publicKeyId, recipientKeyId: bobIdentity.publicKeyId,
  });
  const bobSender = new Bb84ControlSender(bobKeys, {
    roomId, pairKeyId, senderKeyId: bobIdentity.publicKeyId, recipientKeyId: aliceIdentity.publicKeyId,
  });
  const aliceReceiver = new Bb84ControlReceiver(aliceKeys, {
    roomId, pairKeyId, runId, senderKeyId: bobIdentity.publicKeyId, recipientKeyId: aliceIdentity.publicKeyId,
  });
  const bobReceiver = new Bb84ControlReceiver(bobKeys, {
    roomId, pairKeyId, runId, senderKeyId: aliceIdentity.publicKeyId, recipientKeyId: bobIdentity.publicKeyId,
  });
  const endpoints: { alice?: EndpointBb84ChatSession; bob?: EndpointBb84ChatSession } = {};
  const aliceSentKinds: string[] = [];
  const bobSentKinds: string[] = [];
  const send = (sender: Bb84ControlSender, receiver: Bb84ControlReceiver, peer: () => EndpointBb84ChatSession, kinds: string[]) =>
    async (message: { kind: string; payload: Record<string, unknown> }) => {
      kinds.push(message.kind);
      const sealed = await sender.seal(message);
      const opened = await receiver.open(sealed);
      await peer().receive(opened);
    };
  const aliceProgress: Array<{ status: string; qberPpm: number | null; error: string | null }> = [];
  const bobProgress: Array<{ status: string; qberPpm: number | null; error: string | null }> = [];
  let aliceContribution: Uint8Array | null = null;
  let bobContribution: Uint8Array | null = null;
  let aliceTranscript: Uint8Array | null = null;
  let bobTranscript: Uint8Array | null = null;
  endpoints.alice = new EndpointBb84ChatSession('alice', runId, {
    send: send(aliceSender, bobReceiver, () => endpoints.bob!, aliceSentKinds),
    onProgress: (state) => aliceProgress.push({ status: state.status, qberPpm: state.qberPpm, error: state.error }),
    onContribution: (contribution, transcriptHash) => { aliceContribution = contribution; aliceTranscript = transcriptHash; },
  });
  endpoints.bob = new EndpointBb84ChatSession('bob', runId, {
    send: send(bobSender, aliceReceiver, () => endpoints.alice!, bobSentKinds),
    onProgress: (state) => bobProgress.push({ status: state.status, qberPpm: state.qberPpm, error: state.error }),
    onContribution: (contribution, transcriptHash) => { bobContribution = contribution; bobTranscript = transcriptHash; },
  });
  await endpoints.alice!.startAlice({ noisePpm: 0, interceptPpm, qberThresholdPpm: 110_000 });
  return {
    alice: endpoints.alice!, bob: endpoints.bob!, aliceProgress, bobProgress,
    aliceContribution, bobContribution, aliceTranscript, bobTranscript, aliceSentKinds, bobSentKinds,
  };
}

describe('two browser BB84 control exchange', () => {
  it('exchanges encrypted relay messages and independently reaches the same zero-QBER result', async () => {
    const result = await runTwoEndpointExchange(0);
    expect(result.aliceProgress.at(-1)).toMatchObject({ status: 'key_confirmation', qberPpm: 0 });
    expect(result.bobProgress.at(-1)).toMatchObject({ status: 'key_confirmation', qberPpm: 0 });
    expect(result.alice.currentStatus).toBe('key_confirmation');
    expect(result.bob.currentStatus).toBe('key_confirmation');
    expect(result.aliceContribution).toEqual(result.bobContribution);
    expect(result.aliceContribution).toHaveLength(16);
    expect(result.aliceTranscript).toEqual(result.bobTranscript);
    expect(result.aliceSentKinds.filter((kind) => kind === 'reconciliation_query').length).toBeGreaterThan(0);
    expect(result.bobSentKinds.filter((kind) => kind === 'reconciliation_reply').length).toBeGreaterThan(0);
    expect(result.aliceSentKinds).toContain('toeplitz_seed');
    expect(result.aliceProgress.some((item) => item.status === 'exchanging')).toBe(true);
    expect(result.bobProgress.some((item) => item.status === 'sifting')).toBe(true);
    result.alice.markKeyConfirmed();
    result.bob.markKeyConfirmed();
    expect(result.alice.currentStatus).toBe('complete');
    expect(result.bob.currentStatus).toBe('complete');
  });

  it('reports elevated QBER from the endpoint Eve model and fails the sample gate', async () => {
    const result = await runTwoEndpointExchange(1_000_000);
    expect(result.alice.currentStatus).toBe('failed');
    expect(result.bob.currentStatus).toBe('failed');
  });
});
