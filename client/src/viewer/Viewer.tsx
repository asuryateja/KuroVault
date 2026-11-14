import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtBytes, fmtTime } from '../format';
import { IconClose, IconDownload, IconFit, IconLock, IconNext, IconPrev, IconZoomIn } from '../icons';
import { downloadUrl, fmtDuration, infoUrl, isTelegramFile, kindOf, KIND_LABEL, streamUrl, thumbUrl, type DriveFile } from '../media';
import { AudioPlayer } from './AudioPlayer';
import { SmoothPlay } from './SmoothPlay';
import { VideoPlayer } from './VideoPlayer';

const PdfViewer = lazy(() => import('./PdfViewer'));
const ArchiveBrowser = lazy(() => import('./ArchiveBrowser').then(m => ({ default: m.ArchiveBrowser })));
/** Only the top-most viewer (e.g. a video opened from inside an archive) reacts to keys and swipes. */
const isTop = (el: HTMLElement | null) => { const all = document.querySelectorAll('.viewer'); return Boolean(el) && all[all.length - 1] === el; };

type Info = { duration_secs: number | null; width: number | null; height: number | null; audio_title: string | null; audio_performer: string | null };

function ImageView({ file }: { file: DriveFile }) {
  const [actual, setActual] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`imgv ${actual ? 'is-actual' : ''}`} data-testid="image-viewer">
      {!loaded && <span className="spinner spinner-lg" aria-hidden="true" />}
      <img src={streamUrl(file)} alt={file.name} onLoad={() => setLoaded(true)} className={loaded ? 'is-loaded' : ''} onClick={() => setActual(a => !a)} draggable={false} />
      <button className="icon-btn imgv-toggle" onClick={() => setActual(a => !a)} aria-label={actual ? 'Fit to screen' : 'Actual size'}>{actual ? <IconFit /> : <IconZoomIn />}</button>
    </div>
  );
}

export function Viewer({ files, index, onIndex, onClose }: { files: DriveFile[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const file = files[index];
  const kind = kindOf(file);
  const [closing, setClosing] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [dir, setDir] = useState<'next' | 'prev' | null>(null);
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setClosing(true);
    window.setTimeout(onClose, 240);
  }, [onClose]);
  const go = useCallback((delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= files.length) return;
    setDir(delta > 0 ? 'next' : 'prev');
    onIndex(next);
  }, [files.length, index, onIndex]);

  useEffect(() => {
    setInfo(null);
    const url = infoUrl(file);
    if (url && (kind === 'video' || kind === 'audio')) void api<Info>(url).then(setInfo).catch(() => undefined);
  }, [file, kind]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.current?.focus();
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTop(root.current)) return;
      if (e.key === 'Escape' && !document.fullscreenElement) { e.preventDefault(); close(); }
      const media = kind === 'video' || kind === 'audio';
      if (e.key === 'ArrowRight' && (!media || e.shiftKey)) { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft' && (!media || e.shiftKey)) { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, go, kind]);

  const meta = [KIND_LABEL[kind], fmtBytes(file.size), info?.duration_secs ? fmtDuration(info.duration_secs) : null, info?.width && info?.height ? `${info.width}×${info.height}` : null, fmtTime(Date.parse(file.created_at))].filter(Boolean).join(' · ');

  return (
    <div className={`viewer ${closing ? 'is-closing' : ''}`} role="dialog" aria-modal="true" aria-label={`Viewing ${file.name}`} ref={root} tabIndex={-1}
      onTouchStart={e => { if (!root.current?.contains(e.target as Node)) return; const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY, t: Date.now() }; }}
      onTouchEnd={e => {
        const start = touch.current;
        touch.current = null;
        if (!start || !root.current?.contains(e.target as Node) || (e.target as HTMLElement).closest('.vplayer-controls, .aplayer-seek, .aplayer-vol, input, .pdfv-pages')) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Date.now() - start.t > 600) return;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
        else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) close();
      }}>
      <div className="viewer-backdrop" onClick={close} />
      <div className="viewer-panel">
        <header className="viewer-head">
          <div className="viewer-title">
            <strong title={file.name}>{file.name}</strong>
            <span className="mono">{meta}</span>
          </div>
          <span className="viewer-count mono">{index + 1} / {files.length}</span>
          <button className="icon-btn" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous file"><IconPrev /></button>
          <button className="icon-btn" onClick={() => go(1)} disabled={index === files.length - 1} aria-label="Next file"><IconNext /></button>
          {kind !== 'encrypted' && !file.protected && downloadUrl(file) && <a className="icon-btn" href={downloadUrl(file)!} download aria-label="Download"><IconDownload /></a>}
          <button className="icon-btn" onClick={close} aria-label="Close viewer"><IconClose /></button>
        </header>
        <div key={file.id} className={`viewer-stage ${dir ? `from-${dir}` : ''}`}>
          {kind === 'video' && <VideoPlayer src={streamUrl(file)} poster={thumbUrl(file) ?? undefined} title={file.name} codec={file.video_codec} />}
          {kind === 'video' && isTelegramFile(file) && <SmoothPlay file={file} onPlay={() => { const v = root.current?.querySelector('video'); if (v) void v.play().catch(() => undefined); }} />}
          {kind === 'audio' && <AudioPlayer src={streamUrl(file)} title={info?.audio_title || file.name.replace(/\.[^.]+$/, '')} artist={info?.audio_performer} cover={thumbUrl(file)} />}
          {kind === 'image' && <ImageView file={file} />}
          {kind === 'pdf' && <Suspense fallback={<div className="pdfv-loading"><span className="spinner spinner-lg" /></div>}><PdfViewer src={streamUrl(file)} /></Suspense>}
          {kind === 'archive' && <Suspense fallback={<div className="pdfv-loading"><span className="spinner spinner-lg" /></div>}><ArchiveBrowser file={file} /></Suspense>}
          {kind === 'encrypted' && (
            <div className="viewer-note" data-testid="encrypted-note">
              <span className="viewer-note-icon"><IconLock width={26} height={26} /></span>
              <h3>End-to-end encrypted</h3>
              <p>This file is sealed with your Telegram Drive vault key, which never leaves the desktop app. Open it there to decrypt and view.</p>
            </div>
          )}
          {kind === 'other' && (
            <div className="viewer-note">
              <h3>No preview for this type</h3>
              <p>For safety, {file.mime_type || 'this file type'} is never rendered in the browser. Download it to open it with a local app.</p>
              {file.protected ? <p className="sub">This chat has content protection, so it cannot be downloaded.</p> : downloadUrl(file) ? <a className="btn btn-primary" href={downloadUrl(file)!} download>Download</a> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
