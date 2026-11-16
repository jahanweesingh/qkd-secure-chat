import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PresentationDialog } from './PresentationDialog';
import type { EncryptionInfo } from './types';

const originalShow = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShow;
  HTMLDialogElement.prototype.close = originalClose;
});
const encryption: EncryptionInfo = { state: 'waiting_for_peer', canSend: false,
  verificationCode: null, verifiedAt: null, peerName: null, localKeyId: null,
  peerKeyId: null, sessionKeyId: null, keyStorage: null, error: null };
const props = { open: true, events: [], connection: { state: 'connected' as const, attempt: 0, nextRetrySeconds: null, error: null }, encryption,
  messages: [], currentClientId: 'alice', onSend: vi.fn(() => true),
  onClear: vi.fn(), onClose: vi.fn(), onOpenLab: vi.fn(), onOpenSecurity: vi.fn() };

describe('presentation navigation', () => {
  it('wraps keyboard focus through visible controls, including expanded guidance', () => {
    render(<PresentationDialog {...props} />);
    const close = screen.getByRole('button', { name: 'Close encryption demo' });
    const summary = screen.getByText('Packet capture guide');
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(summary).toHaveFocus();
    fireEvent.keyDown(summary, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.click(summary);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('link', { name: /Wireshark stream inspection guide/ })).toHaveFocus();
  });

  it('closes the native modal before switching to the existing lab', () => {
    const onClose = vi.fn(); const onOpenLab = vi.fn(() => expect(document.querySelector('dialog')?.open).toBe(false));
    render(<PresentationDialog {...props} onClose={onClose} onOpenLab={onOpenLab} />);
    fireEvent.click(screen.getByText('Live activity & security details'));
    fireEvent.click(screen.getByRole('button', { name: 'Open BB84 lab' }));
    expect(onClose).toHaveBeenCalledOnce(); expect(onOpenLab).toHaveBeenCalledOnce();
  });
});
