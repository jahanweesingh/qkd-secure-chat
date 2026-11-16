import { AlertCircle, Download, FileImage, Film, LoaderCircle, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { attachmentSize, downloadAttachment, parseAttachment } from './attachments';
import type { AttachmentManifest } from './attachments';
import './attachment.css';

export function AttachmentMessage({ text, roomId }: { text: string; roomId: string }) {
  let manifest: AttachmentManifest | null = null;
  try { manifest = parseAttachment(text); } catch { /* Never render a malformed secret manifest. */ }
  if (!manifest) return <span className="attachment-invalid"><AlertCircle size={16} /> This attachment cannot be opened.</span>;
  return <AttachmentContent key={`${roomId}:${manifest.id}`} manifest={manifest} roomId={roomId} />;
}

function AttachmentContent({ manifest, roomId }: { manifest: AttachmentManifest; roomId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const blobUrl = useRef<string | null>(null);
  const video = manifest.mime.startsWith('video/');

  useEffect(() => () => {
    controller.current?.abort();
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
  }, []);

  const open = async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      const blob = await downloadAttachment(manifest, roomId, request.signal);
      if (request.signal.aborted) return;
      const localUrl = URL.createObjectURL(blob);
      blobUrl.current = localUrl;
      setUrl(localUrl);
    } catch (caught) {
      if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : 'Could not open the encrypted attachment.');
    } finally {
      if (!request.signal.aborted) setBusy(false);
      controller.current = null;
    }
  };

  return (
    <div className="attachment-message">
      <div className="attachment-message__heading">
        <span className="attachment-message__icon" aria-hidden="true">{video ? <Film size={23} /> : <FileImage size={23} />}</span>
        <div><strong>{manifest.name}</strong><small>{video ? 'Video' : 'Image'} · {attachmentSize(manifest.size)}</small></div>
        <Lock size={14} aria-label="Encrypted attachment" />
      </div>
      {url && (video
        ? <video className="attachment-message__media" src={url} controls playsInline preload="metadata" onError={() => setError('This browser cannot preview this video codec. You can save the file and open it in a compatible player.')} />
        : <img className="attachment-message__media" src={url} alt={manifest.name} onError={() => setError('This image cannot be previewed. You can save the file to inspect it.')} />)}
      {error && <p className="attachment-message__error" role="alert"><AlertCircle size={15} />{error}</p>}
      <div className="attachment-message__actions">
        {url
          ? <a href={url} download={manifest.name}><Download size={15} /> Save {video ? 'video' : 'image'}</a>
          : <button type="button" onClick={open} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            {busy ? 'Downloading & decrypting…' : error ? 'Retry download' : `Open ${video ? 'video' : 'image'}`}
          </button>}
        <small>{url ? 'Decrypted in this browser' : 'Encrypted before upload'}</small>
      </div>
    </div>
  );
}
