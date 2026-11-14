import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { IconFit, IconZoomIn, IconZoomOut } from '../icons';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

function Page({ doc, index, scale, onVisible }: { doc: PDFDocumentProxy; index: number; scale: number; onVisible: (n: number) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void doc.getPage(index).then(page => {
      const vp = page.getViewport({ scale });
      if (!cancelled) setSize({ w: vp.width, h: vp.height });
    });
    return () => { cancelled = true; };
  }, [doc, index, scale]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) setShown(true);
        if (entry.intersectionRatio > 0.5) onVisible(index);
      }
    }, { rootMargin: '400px 0px', threshold: [0, 0.5] });
    io.observe(el);
    return () => io.disconnect();
  }, [index, onVisible]);

  useEffect(() => {
    if (!shown || !size) return undefined;
    let task: ReturnType<pdfjs.PDFPageProxy['render']> | null = null;
    let cancelled = false;
    void doc.getPage(index).then(page => {
      if (cancelled || !canvas.current) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: scale * dpr });
      // Render off-screen, then swap in, so zooming never flashes a blank page.
      const off = document.createElement('canvas');
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = page.render({ canvas: off, canvasContext: off.getContext('2d')!, viewport: vp });
      task.promise.then(() => {
        const c = canvas.current;
        if (cancelled || !c) return;
        c.width = off.width;
        c.height = off.height;
        c.getContext('2d')!.drawImage(off, 0, 0);
        c.classList.add('is-rendered');
      }).catch(() => undefined);
    });
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, index, scale, shown, size]);

  return (
    <div ref={holder} className="pdf-page" style={size ? { width: size.w, height: size.h, ['--k' as string]: index } : { ['--k' as string]: index }} data-page={index}>
      <canvas ref={canvas} aria-label={`Page ${index}`} />
    </div>
  );
}

export default function PdfViewer({ src, onError }: { src: string; onError?: (m: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const task = pdfjs.getDocument({ url: src, withCredentials: false });
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => setProgress(total ? loaded / total : 0);
    task.promise.then(async d => {
      const first = await d.getPage(1);
      const width = (scroller.current?.clientWidth ?? 800) - 32;
      const fit = Math.min(1.25, Math.max(0.4, width / first.getViewport({ scale: 1 }).width));
      setScale(Math.round(fit * 100) / 100);
      setDoc(d);
    }).catch(e => {
      const msg = /password/i.test(String(e?.name)) ? 'This PDF is password-protected.' : 'The PDF could not be opened.';
      setError(msg);
      onError?.(msg);
    });
    return () => { void task.destroy(); };
  }, [src, onError]);

  async function fitWidth() {
    if (!doc) return;
    const first = await doc.getPage(1);
    const width = (scroller.current?.clientWidth ?? 800) - 32;
    setScale(Math.round(Math.max(0.4, width / first.getViewport({ scale: 1 }).width) * 100) / 100);
  }

  return (
    <div className="pdfv" data-testid="pdf-viewer">
      <div className="pdfv-bar">
        <span className="mono" data-testid="pdf-page">{doc ? `${page} / ${doc.numPages}` : '— / —'}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => setScale(s => Math.max(0.3, Math.round((s - 0.2) * 100) / 100))} aria-label="Zoom out"><IconZoomOut /></button>
        <span className="mono pdfv-zoom" data-testid="pdf-zoom">{Math.round(scale * 100)}%</span>
        <button className="icon-btn" onClick={() => setScale(s => Math.min(4, Math.round((s + 0.2) * 100) / 100))} aria-label="Zoom in"><IconZoomIn /></button>
        <button className="icon-btn" onClick={() => void fitWidth()} aria-label="Fit to width"><IconFit /></button>
      </div>
      <div ref={scroller} className="pdfv-pages">
        {error && <div className="vplayer-error static" role="alert">{error}</div>}
        {!doc && !error && (
          <div className="pdfv-loading">
            <div className="pdfv-sheet" aria-hidden="true"><i /><i /><i /><i /><i /><i /><span className="pdfv-band" /></div>
            <span className="mono">Opening document… {Math.round(progress * 100)}%</span>
          </div>
        )}
        {doc && Array.from({ length: doc.numPages }, (_, i) => <Page key={i} doc={doc} index={i + 1} scale={scale} onVisible={setPage} />)}
      </div>
    </div>
  );
}
