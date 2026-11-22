import type { EndpointBb84Progress } from './bb84ChatSession';
import type { EncryptionInfo } from './types';

export interface EndpointBb84RuntimeStatus {
  session: 'Not started' | 'In progress' | 'Completed' | 'Failed';
  chatMode: 'No active chat key' | 'ECDH-only' | 'BB84-ECDH hybrid active';
  contribution: 'Not started' | 'In progress' | 'Confirmed' | 'Failed';
  contributionInChat: 'Active in hybrid epoch' | 'Inactive · ECDH fallback active' | 'Inactive';
  reconciliation: 'Pending' | 'In progress' | 'Completed' | 'Incomplete';
  privacyAmplification: 'Pending' | 'In progress' | 'Completed' | 'Incomplete';
  keyConfirmation: 'Not reached' | 'Pending' | 'Confirmed' | 'Not confirmed';
  hybridEpoch: 'Not active' | 'Active' | 'Inactive · failed closed';
}

/** Shared presentation model sourced only from the live chat key mode and endpoint protocol state. */
export function getEndpointBb84RuntimeStatus(
  encryption: EncryptionInfo,
  endpointBb84: EndpointBb84Progress,
): EndpointBb84RuntimeStatus {
  const activeHybrid = encryption.activeKeyMode === 'bb84_hybrid';
  const completed = endpointBb84.status === 'complete';
  const failed = endpointBb84.status === 'failed';
  const progressing = ['preparing', 'exchanging', 'sifting', 'sampling', 'reconciling', 'privacy_amplification', 'key_confirmation'].includes(endpointBb84.status);
  const reconciliationDone = completed || ['privacy_amplification', 'key_confirmation'].includes(endpointBb84.status);
  const privacyDone = completed || endpointBb84.status === 'key_confirmation';

  return {
    session: completed ? 'Completed' : failed ? 'Failed' : progressing ? 'In progress' : 'Not started',
    chatMode: activeHybrid ? 'BB84-ECDH hybrid active'
      : encryption.activeKeyMode === 'ecdh' ? 'ECDH-only' : 'No active chat key',
    contribution: activeHybrid || completed ? 'Confirmed' : failed ? 'Failed' : progressing ? 'In progress' : 'Not started',
    contributionInChat: activeHybrid ? 'Active in hybrid epoch'
      : encryption.activeKeyMode === 'ecdh' ? 'Inactive · ECDH fallback active' : 'Inactive',
    reconciliation: reconciliationDone ? 'Completed'
      : failed ? 'Incomplete' : endpointBb84.status === 'reconciling' ? 'In progress' : 'Pending',
    privacyAmplification: privacyDone ? 'Completed'
      : failed ? 'Incomplete' : endpointBb84.status === 'privacy_amplification' ? 'In progress' : 'Pending',
    keyConfirmation: activeHybrid || completed ? 'Confirmed'
      : failed ? 'Not confirmed' : endpointBb84.status === 'key_confirmation' ? 'Pending' : 'Not reached',
    hybridEpoch: activeHybrid ? 'Active' : failed ? 'Inactive · failed closed' : 'Not active',
  };
}
