/** File bytes are encrypted before HTTP upload. The manifest MUST only be sent
 * inside the existing authenticated encrypted chat envelope, never over HTTP. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_PREFIX = 'QKD-ATTACHMENT-V1:';
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/ogg'] as const;
export const ATTACHMENT_ACCEPT = ALLOWED_TYPES.join(',');
const encoder = new TextEncoder();
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID_MANIFEST = 'This attachment message is invalid and cannot be opened.';

export interface AttachmentManifest {
  id: string;
  name: string;
  mime: typeof ALLOWED_TYPES[number];
  size: number;
  key: string;
  iv: string;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(INVALID_MANIFEST);
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  if (bytes.length !== length || encode(bytes) !== value) throw new Error(INVALID_MANIFEST);
  return bytes;
}

export function isAttachmentMessage(text: string): boolean {
  return text.startsWith(ATTACHMENT_PREFIX);
}

export function parseAttachment(text: string): AttachmentManifest | null {
  if (!isAttachmentMessage(text)) return null;
  try {
    if (text.length > 2000 || encoder.encode(text).length > 4096) throw new Error();
    const value: unknown = JSON.parse(text.slice(ATTACHMENT_PREFIX.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const m = value as Record<string, unknown>;
    if (Object.keys(m).sort().join(',') !== 'id,iv,key,mime,name,size'
      || typeof m.id !== 'string' || !ID_PATTERN.test(m.id)
      || typeof m.name !== 'string' || m.name.trim() !== m.name || !m.name
      || [...m.name].length > 120 || /[\p{Cc}\p{Cf}\\/]/u.test(m.name)
      || typeof m.mime !== 'string' || !(ALLOWED_TYPES as readonly string[]).includes(m.mime)
      || safeName(m.name, m.mime) !== m.name
      || !Number.isInteger(m.size) || (m.size as number) < 1 || (m.size as number) > MAX_ATTACHMENT_BYTES
      || typeof m.key !== 'string' || m.key.length !== 43 || typeof m.iv !== 'string' || m.iv.length !== 16) throw new Error();
    decode(m.key, 32);
    decode(m.iv, 12);
    return m as unknown as AttachmentManifest;
  } catch {
    // Never include raw manifest/key material in errors or diagnostics.
    throw new Error(INVALID_MANIFEST);
  }
}

export function validateAttachmentFile(file: File): void {
  if (!(ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    throw new Error('Choose a JPEG, PNG, WebP or GIF image, or an MP4, WebM or Ogg video.');
  }
  if (!file.size) throw new Error('This file is empty. Choose another image or video.');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Choose a file up to 10 MB. Trim or compress larger videos first.');
}

function safeName(name: string, mime: string): string {
  const clean = [...name.replace(/[\p{Cc}\p{Cf}\\/]/gu, '_')].slice(0, 120).join('').trim();
  const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv' };
  const extension = extensions[mime];
  // A safe media suffix also prevents a misleading executable/HTML download name.
  if (!clean) return `attachment.${extension}`;
  if (clean.toLowerCase().endsWith(`.${extension}`) || (mime === 'image/jpeg' && /\.jpe?g$/i.test(clean)) || (mime === 'video/ogg' && /\.ogg$/i.test(clean))) return clean;
  return `${[...clean].slice(0, 115).join('')}.${extension}`;
}

function hasMediaSignature(bytes: Uint8Array, mime: string): boolean {
  const starts = (...prefix: number[]) => prefix.every((value, i) => bytes[i] === value);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  switch (mime) {
    case 'image/png': return starts(137, 80, 78, 71, 13, 10, 26, 10);
    case 'image/jpeg': return starts(255, 216, 255);
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
    case 'image/webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'video/mp4': return ascii(4, 8) === 'ftyp';
    case 'video/webm': return starts(0x1a, 0x45, 0xdf, 0xa3);
    case 'video/ogg': return ascii(0, 4) === 'OggS';
    default: return false;
  }
}

function binding(roomId: string, attachmentId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(['qkd-chat-attachment-v1', roomId, attachmentId]));
}

function attachmentUrl(roomId: string, id: string): string {
  // Never accept a server address or fetch URL from the decrypted manifest.
  return `/api/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(id)}`;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Attachment transfer cancelled.', 'AbortError');
}

async function transfer<T>(signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkAbort(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 60_000);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function prepareAttachment(file: File, roomId: string, signal?: AbortSignal): Promise<string> {
  validateAttachmentFile(file);
  checkAbort(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasMediaSignature(bytes, file.type)) throw new Error('The file contents do not match its image or video format. Choose another file.');
  checkAbort(signal);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const manifest: AttachmentManifest = {
    id: crypto.randomUUID(), name: safeName(file.name, file.type), mime: file.type as AttachmentManifest['mime'],
    size: file.size, key: encode(rawKey), iv: encode(crypto.getRandomValues(new Uint8Array(12))),
  };
  const serialized = ATTACHMENT_PREFIX + JSON.stringify(manifest);
  parseAttachment(serialized);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  rawKey.fill(0);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: decode(manifest.iv, 12), additionalData: binding(roomId, manifest.id), tagLength: 128 }, key, bytes);
  checkAbort(signal);
  await transfer(signal, async transferSignal => {
    const response = await fetch(attachmentUrl(roomId, manifest.id), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext,
      signal: transferSignal, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) {
      if (response.status === 413) throw new Error('The file exceeds the transfer limit or this room’s storage is full. Try a smaller file or start a new room.');
      if (response.status === 507) throw new Error('Attachment storage is full on the server. Ask the room host to free space.');
      if (response.status === 429) throw new Error('The server is busy with another transfer. Wait a moment and retry.');
      throw new Error('The encrypted upload did not complete. Check your connection and try again.');
    }
  });
  checkAbort(signal);
  return serialized;
}

async function readCiphertext(response: Response, expected: number): Promise<Uint8Array<ArrayBuffer>> {
  const stated = response.headers.get('Content-Length');
  if (stated !== null && (!/^\d+$/.test(stated) || Number(stated) !== expected)) {
    await response.body?.cancel();
    throw new Error('The encrypted attachment has an invalid length.');
  }
  if (!response.body) throw new Error('The encrypted attachment is empty.');
  const reader = response.body.getReader();
  const output = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expected) throw new Error('The encrypted attachment exceeds its expected size.');
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expected) throw new Error('The encrypted attachment is incomplete.');
    return output;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function downloadAttachment(manifest: AttachmentManifest, roomId: string, signal?: AbortSignal): Promise<Blob> {
  // Validate again at the boundary even if callers constructed an object directly.
  parseAttachment(ATTACHMENT_PREFIX + JSON.stringify(manifest));
  const ciphertext = await transfer(signal, async transferSignal => {
    const response = await fetch(attachmentUrl(roomId, manifest.id), {
      signal: transferSignal, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new Error(response.status === 404 ? 'This encrypted attachment is no longer available.' : 'Could not download the encrypted attachment. Check your connection and retry.');
    return readCiphertext(response, manifest.size + 16);
  });
  checkAbort(signal);
  const rawKey = decode(manifest.key, 32);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  rawKey.fill(0);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(manifest.iv, 12), additionalData: binding(roomId, manifest.id), tagLength: 128 }, key, ciphertext);
  } catch {
    throw new Error('This attachment failed its encryption integrity check. It was not opened.');
  }
  checkAbort(signal);
  if (plaintext.byteLength !== manifest.size || !hasMediaSignature(new Uint8Array(plaintext), manifest.mime)) throw new Error('This attachment has an invalid media format. It was not opened.');
  return new Blob([plaintext], { type: manifest.mime });
}

export function attachmentSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
