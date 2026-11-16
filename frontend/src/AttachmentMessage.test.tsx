import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentMessage } from './AttachmentMessage';
import { ATTACHMENT_PREFIX, downloadAttachment } from './attachments';

vi.mock('./attachments', async importOriginal => ({
  ...await importOriginal<typeof import('./attachments')>(),
  downloadAttachment: vi.fn(),
}));
const manifest = {
  id: '01234567-89ab-4def-8123-0123456789ab', name: 'photo.png', mime: 'image/png',
  size: 50, key: 'A'.repeat(43), iv: 'A'.repeat(16),
};
const text = ATTACHMENT_PREFIX + JSON.stringify(manifest);
const createObjectURL = vi.fn(() => 'blob:private-image');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.mocked(downloadAttachment).mockReset();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
});
afterEach(() => vi.clearAllMocks());

describe('attachment message UI', () => {
  it('downloads only on request, displays authenticated media, and revokes its URL', async () => {
    vi.mocked(downloadAttachment).mockResolvedValue(new Blob(['media'], { type: 'image/png' }));
    const { unmount, container } = render(<AttachmentMessage text={text} roomId="ROOM-42" />);
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(manifest.key);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
    expect(screen.getByRole('button', { name: 'Downloading & decrypting…' })).toBeDisabled();
    expect(await screen.findByRole('img', { name: 'photo.png' })).toHaveAttribute('src', 'blob:private-image');
    expect(screen.getByRole('link', { name: 'Save image' })).toHaveAttribute('download', 'photo.png');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-image');
  });

  it('shows an integrity failure without making a media URL and permits retry', async () => {
    vi.mocked(downloadAttachment).mockRejectedValue(new Error('Integrity check failed.'));
    render(<AttachmentMessage text={text} roomId="ROOM-42" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Integrity check failed');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry download' })).toBeEnabled();
  });

  it('never renders malformed manifests or secret material as plain text', () => {
    const { container } = render(<AttachmentMessage text={`${ATTACHMENT_PREFIX}{"key":"sensitive-material"}`} roomId="ROOM-42" />);
    expect(container.textContent).toContain('cannot be opened');
    expect(container.textContent).not.toContain('sensitive-material');
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it('offers video controls without autoplay', async () => {
    vi.mocked(downloadAttachment).mockResolvedValue(new Blob(['video'], { type: 'video/webm' }));
    const { container } = render(<AttachmentMessage text={ATTACHMENT_PREFIX + JSON.stringify({ ...manifest, name: 'clip.webm', mime: 'video/webm' })} roomId="ROOM-42" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open video' }));
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video')!;
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.preload).toBe('metadata');
  });

  it('aborts a pending transfer when its message unmounts', async () => {
    vi.mocked(downloadAttachment).mockImplementation(async (_m, _room, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    }));
    const { unmount } = render(<AttachmentMessage text={text} roomId="ROOM-42" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
    const signal = vi.mocked(downloadAttachment).mock.calls[0][2]!;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
