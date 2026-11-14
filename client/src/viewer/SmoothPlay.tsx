import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtBytes } from '../format';
import { prepareUrl, type DriveFile } from '../media';

type Status = {
  state: 'none' | 'downloading' | 'ready' | 'error'; error?: string | null;
  received?: number; size?: number; percent?: number; rate?: number; etaSeconds?: number | null;
  readyToPlay?: boolean; readyAtPercent?: number; readyInSeconds?: number | null;
};

const OFFER_FROM_BYTES = 20 * 1024 * 1024; // smaller files start fast enough on their own
const fmtSecs = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

/**
 * "Watch without buffering": the server fetches the video from Telegram first, shows how far along it is,
 * and says when playback can start without stopping (it keeps downloading in the background).
 */
export function SmoothPlay({ file, onPlay }: { file: DriveFile; onPlay: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [engaged, setEngaged] = useState(false); // preparing in this viewing: show "Ready" when it finishes
  const [error, setError] = useState('');
  const url = prepareUrl(file);
  const timer = useRef(0);

  const poll = useCallback(async () => {
    try {
      const s = await api<Status>(url);
      setStatus(s);
      if (s.state === 'downloading') { setEngaged(true); timer.current = window.setTimeout(poll, 1000); }
    } catch { /* not a Telegram file or offline: just play normally */ setStatus({ state: 'none' }); setDismissed(true); }
  }, [url]);

  useEffect(() => { setDismissed(false); setEngaged(false); setError(''); void poll(); return () => window.clearTimeout(timer.current); }, [poll]);

  async function prepare() {
    setError('');
    try {
      const s = await api<Status>(url, { method: 'POST' });
      if (s.state === 'error') { setError(s.error ?? 'Could not prepare this video.'); return; }
      setStatus(s);
      setEngaged(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(poll, 800);
    } catch (e) { setError((e as Error).message); }
  }
  async function cancel() {
    window.clearTimeout(timer.current);
    await api(url, { method: 'DELETE' }).catch(() => undefined);
    setStatus({ state: 'none' });
  }
  const play = () => { setDismissed(true); onPlay(); };

  if (!status) return null;
  const s = status;
  const downloading = s.state === 'downloading';

  // After playback starts, a small chip keeps showing how the preparation is going.
  if (dismissed) {
    if (!downloading && s.state !== 'ready') return null;
    return (
      <div className="smooth-chip" role="status" aria-label="Preparation progress">
        <span className={`dot dot-${s.state === 'ready' ? 'ok' : 'warn'}`} aria-hidden="true" />
        {s.state === 'ready' ? 'Prepared · plays from the server' : `Preparing ${Math.floor(s.percent ?? 0)}%`}
      </div>
    );
  }
  if (s.state === 'none' && file.size < OFFER_FROM_BYTES) return null;
  if (s.state === 'ready' && !engaged) return null;

  return (
    <div className="smooth" role="dialog" aria-label="Smooth playback">
      <div className="smooth-card">
        {s.state === 'none' || s.state === 'error' ? (
          <>
            <h3>Watch without buffering</h3>
            <p>Kurovault can fetch this video from Telegram onto the server first, then play it smoothly from there. You will see when it is ready.</p>
            {(error || s.error) && <div className="error-note" role="alert">{error || s.error}</div>}
            <div className="smooth-actions">
              <button className="btn btn-primary btn-lg" onClick={() => void prepare()}>Prepare for smooth playback</button>
              <button className="btn btn-ghost btn-lg" onClick={play}>Play now</button>
            </div>
            <p className="sub">{fmtBytes(file.size)}{file.size > 1.5e9 ? ' · large file, this can take a while' : ''}</p>
          </>
        ) : (
          <>
            <h3>{s.readyToPlay || s.state === 'ready' ? 'Ready — plays without buffering' : 'Preparing for smooth playback'}</h3>
            <div className="smooth-percent mono" aria-live="polite"><b>{Math.floor(s.percent ?? 0)}%</b> <span className="sub">{fmtBytes(s.received ?? 0)} of {fmtBytes(s.size ?? 0)}</span></div>
            <div className="smooth-bar" role="progressbar" aria-label="Downloaded to the server" aria-valuenow={Math.floor(s.percent ?? 0)} aria-valuemin={0} aria-valuemax={100}>
              <span className="smooth-fill" style={{ width: `${s.percent ?? 0}%` }} />
              {!s.readyToPlay && (s.readyAtPercent ?? 100) < 100 && <span className="smooth-mark" style={{ left: `${s.readyAtPercent}%` }} title="Playback can start here" />}
            </div>
            <p className="sub smooth-meta">
              {(s.rate ?? 0) > 0 ? `${fmtBytes(s.rate ?? 0)}/s from Telegram` : 'Connecting to Telegram…'}
              {s.readyToPlay
                ? ` · the rest arrives before you get to it${s.etaSeconds ? ` (done in ~${fmtSecs(s.etaSeconds)})` : ''}`
                : s.readyInSeconds != null ? ` · ready to play in ~${fmtSecs(s.readyInSeconds)} (at ${s.readyAtPercent}%)` : ''}
            </p>
            <div className="smooth-actions">
              {s.readyToPlay || s.state === 'ready'
                ? <button className="btn btn-primary btn-lg" onClick={play}>Play</button>
                : <button className="btn btn-ghost btn-lg" onClick={play}>Play now anyway</button>}
              {s.state !== 'ready' && <button className="link-plain sub" onClick={() => void cancel()}>Cancel preparation</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
