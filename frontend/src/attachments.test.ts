import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_PREFIX, MAX_ATTACHMENT_BYTES, downloadAttachment, isAttachmentMessage, parseAttachment, prepareAttachment, validateAttachmentFile } from './attachments';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5]);
function file(bytes = png, name = 'photo.png', type = 'image/png'): File {
  return { name, type, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } as File;
}
async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}
function storage() {
  let encrypted = new Uint8Array();
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      encrypted = new Uint8Array(options.body as ArrayBuffer);
      return new Response(null, { status: 201 });
    }
    return new Response(encrypted, { headers: { 'Content-Length': String(encrypted.length) } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, encrypted: () => encrypted };
}
afterEach(() => vi.unstubAllGlobals());

describe('encrypted image and video attachments', () => {
  it('uploads only opaque bytes and roundtrips from the protected chat manifest', async () => {
    const remote = storage();
    const text = await prepareAttachment(file(), 'ROOM-42');
    expect(text.length).toBeLessThan(2000);
    const m = parseAttachment(text)!;
    expect(m.name).toBe('photo.png');
    expect(remote.encrypted()).toHaveLength(png.length + 16);
    expect(remote.encrypted().slice(0, png.length)).not.toEqual(png);
    const [url, request] = remote.fetchMock.mock.calls[0];
    expect(url).toBe(`/api/rooms/ROOM-42/attachments/${m.id}`);
    expect(url).not.toContain(m.key);
    expect(JSON.stringify(request?.headers)).not.toMatch(/photo|image\/png|key|iv/);
    expect(Object.prototype.toString.call(request?.body)).toBe('[object ArrayBuffer]');
    const result = await downloadAttachment(m, 'ROOM-42');
    expect(result.type).toBe('image/png');
    expect(new Uint8Array(await bytesOf(result))).toEqual(png);
  });

  it('generates a fresh key, IV and identifier for every file', async () => {
    storage();
    const a = parseAttachment(await prepareAttachment(file(), 'ROOM-42'))!;
    const b = parseAttachment(await prepareAttachment(file(), 'ROOM-42'))!;
    expect(a.key).not.toBe(b.key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects tampering and a different room or attachment identifier', async () => {
    const remote = storage();
    const m = parseAttachment(await prepareAttachment(file(), 'ROOM-42'))!;
    await expect(downloadAttachment(m, 'OTHER-ROOM')).rejects.toThrow(/integrity/);
    await expect(downloadAttachment({ ...m, id: crypto.randomUUID() }, 'ROOM-42')).rejects.toThrow(/integrity/);
    remote.encrypted()[0] ^= 1;
    await expect(downloadAttachment(m, 'ROOM-42')).rejects.toThrow(/integrity/);
  });

  it('keeps ordinary text separate and never treats malformed reserved content as text', () => {
    expect(parseAttachment('hello')).toBeNull();
    expect(isAttachmentMessage('hello')).toBe(false);
    expect(isAttachmentMessage(`${ATTACHMENT_PREFIX}garbage`)).toBe(true);
    expect(() => parseAttachment(`${ATTACHMENT_PREFIX}garbage`)).toThrow('This attachment message is invalid');
    expect(() => parseAttachment(`${ATTACHMENT_PREFIX}${'x'.repeat(2100)}`)).toThrow();
  });

  it('strictly validates manifest secrets, identifiers, type, name and bounds', async () => {
    storage();
    const m = parseAttachment(await prepareAttachment(file(), 'ROOM-42'))!;
    for (const bad of [
      { ...m, size: 0 }, { ...m, size: MAX_ATTACHMENT_BYTES + 1 }, { ...m, size: 1.5 },
      { ...m, id: '../secret' }, { ...m, key: 'secret' }, { ...m, iv: 'a'.repeat(16) + '=' },
      { ...m, mime: 'image/svg+xml' }, { ...m, name: '../image.png' }, { ...m, name: '\u202eimage.png' },
      { ...m, name: 'a'.repeat(121) }, { ...m, name: 'picture.html' }, { ...m, url: 'https://example.test/collect' },
    ]) expect(() => parseAttachment(ATTACHMENT_PREFIX + JSON.stringify(bad))).toThrow('This attachment message is invalid');
  });

  it('rejects unsafe types, empty, oversized and mislabeled files before upload', async () => {
    const remote = storage();
    expect(() => validateAttachmentFile(file(png, 'vector.svg', 'image/svg+xml'))).toThrow(/Choose/);
    expect(() => validateAttachmentFile(file(new Uint8Array()))).toThrow(/empty/);
    expect(() => validateAttachmentFile({ ...file(), size: MAX_ATTACHMENT_BYTES + 1 } as File)).toThrow(/10 MB/);
    await expect(prepareAttachment(file(new TextEncoder().encode('<svg/>')), 'ROOM-42')).rejects.toThrow(/do not match/);
    expect(remote.fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes private filenames and confines downloads to a media suffix', async () => {
    storage();
    const m = parseAttachment(await prepareAttachment(file(png, '../secret\u202e.html'), 'ROOM-42'))!;
    expect(m.name).not.toMatch(/[\p{Cf}\\]/u);
    expect(m.name).not.toContain('/');
    expect(m.name.endsWith('.png')).toBe(true);
  });

  it('roundtrips supported video bytes without placing type or name on HTTP', async () => {
    storage();
    const video = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    const m = parseAttachment(await prepareAttachment(file(video, 'clip.webm', 'video/webm'), 'ROOM-42'))!;
    const result = await downloadAttachment(m, 'ROOM-42');
    expect(result.type).toBe('video/webm');
    expect(new Uint8Array(await bytesOf(result))).toEqual(video);
  });

  it('bounds a streaming response even without a Content-Length header', async () => {
    storage();
    const m = parseAttachment(await prepareAttachment(file(), 'ROOM-42'))!;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(m.size + 17)); }, cancel,
    }))));
    await expect(downloadAttachment(m, 'ROOM-42')).rejects.toThrow(/expected size/);
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects truncated responses and dishonest lengths before decrypting', async () => {
    storage();
    const m = parseAttachment(await prepareAttachment(file(), 'ROOM-42'))!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(3))));
    await expect(downloadAttachment(m, 'ROOM-42')).rejects.toThrow(/incomplete/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(3), { headers: { 'Content-Length': '99999999999' } })));
    await expect(downloadAttachment(m, 'ROOM-42')).rejects.toThrow(/invalid length/);
  });

  it('cancels before upload and explains failed storage without exposing payloads', async () => {
    const remote = storage();
    const controller = new AbortController(); controller.abort();
    await expect(prepareAttachment(file(), 'ROOM-42', controller.signal)).rejects.toThrow(/cancelled/);
    expect(remote.fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 507 })));
    await expect(prepareAttachment(file(), 'ROOM-42')).rejects.toThrow(/storage is full/);
  });
});
