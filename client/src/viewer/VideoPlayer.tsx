import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { IconBack10, IconExpand, IconFwd10, IconMute, IconPause, IconPip, IconPlay, IconShrink, IconVolume } from '../icons';
import { fmtDuration } from '../media';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function VideoPlayer({ src, poster, title, onError, codec }: { src: string; poster?: string; title: string; onError?: (message: string) => void; codec?: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number>(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [waiting, setWaiting] = useState(true);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  const v = () => video.current!;
  const poke = useCallback(() => {
    setIdle(false);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setIdle(true), 2600);
  }, []);

  const toggle = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined); else el.pause();
    setFlash(el.paused ? 'pause' : 'play');
    window.setTimeout(() => setFlash(null), 500);
  }, []);
  const seekBy = useCallback((delta: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.min(Math.max(0, el.currentTime + delta), el.duration || 0);
    poke();
  }, [poke]);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onMeta = () => { setDuration(el.duration); setWaiting(false); };
    const onProgress = () => { if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1)); };
    const onErr = () => {
      const code = el.error?.code;
      // Browsers report a failed request the same way as an unsupported format, so ask the server what happened.
      void fetch(src, { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin', cache: 'no-store' })
        .then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            return `The server could not stream this video: ${body?.error?.message ?? `error ${res.status}`}`;
          }
          void res.body?.cancel();
          return code === 4
            ? `This browser cannot decode this video${codec ? ` (${codec.toUpperCase()})` : ''}. Try Chrome or Edge, or download it to watch locally.`
            : 'The connection to the video was interrupted. Press play to try again.';
        })
        .catch(() => 'The video could not be loaded. Check your connection.')
        .then(msg => { setError(msg); onError?.(msg); });
    };
    const handlers: [string, () => void][] = [
      ['timeupdate', onTime], ['loadedmetadata', onMeta], ['durationchange', onMeta], ['progress', onProgress],
      ['play', () => setPlaying(true)], ['pause', () => setPlaying(false)], ['ended', () => setPlaying(false)],
      ['waiting', () => setWaiting(true)], ['playing', () => setWaiting(false)], ['canplay', () => setWaiting(false)], ['error', onErr],
      ['volumechange', () => { setVolume(el.volume); setMuted(el.muted); }],
    ];
    handlers.forEach(([e, h]) => el.addEventListener(e, h));
    void el.play().catch(() => setWaiting(false));
    return () => handlers.forEach(([e, h]) => el.removeEventListener(e, h));
  }, [src, onError, codec]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
      else if ((k === 'arrowleft' || k === 'j') && !e.shiftKey) { e.preventDefault(); seekBy(k === 'j' ? -10 : -5); }
      else if ((k === 'arrowright' || k === 'l') && !e.shiftKey) { e.preventDefault(); seekBy(k === 'l' ? 10 : 5); }
      else if (k === 'm') { v().muted = !v().muted; }
      else if (k === 'f') { void toggleFullscreen(); }
      else if (k === 'arrowup') { e.preventDefault(); v().volume = Math.min(1, v().volume + 0.1); }
      else if (k === 'arrowdown') { e.preventDefault(); v().volume = Math.max(0, v().volume - 0.1); }
      else return;
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    else await frame.current?.requestFullscreen?.().catch(() => undefined);
  }
  async function pip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v().requestPictureInPicture();
    } catch { /* unsupported */ }
  }
  function seekTo(e: RPointerEvent<HTMLDivElement>) {
    const rect = bar.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (duration) v().currentTime = ratio * duration;
  }

  const pct = duration ? (time / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;
  return (
    <div ref={frame} className={`vplayer ${idle && playing ? 'is-idle' : ''} ${fullscreen ? 'is-fullscreen' : ''}`} onPointerMove={poke} onPointerDown={poke} data-testid="video-player">
      <video ref={video} src={src} poster={poster} playsInline preload="metadata" onClick={toggle} onDoubleClick={() => void toggleFullscreen()} aria-label={title} />
      {waiting && !error && <div className="vplayer-wait" aria-hidden="true"><span className="spinner spinner-lg" /></div>}
      {flash && <div className={`vplayer-flash flash-${flash}`} aria-hidden="true">{flash === 'play' ? <IconPlay /> : <IconPause />}</div>}
      {!playing && !waiting && !error && <button className="vplayer-big" onClick={toggle} aria-label="Play"><IconPlay width={30} height={30} /></button>}
      {error && <div className="vplayer-error" role="alert">{error}</div>}
      <div className="vplayer-controls">
        <div ref={bar} className="vplayer-bar" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)} tabIndex={0}
          onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); seekTo(e); }}
          onPointerMove={e => {
            const rect = bar.current!.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            setHover({ x: ratio * 100, t: ratio * duration });
            if (e.buttons === 1) seekTo(e);
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); seekBy(e.key === 'ArrowLeft' ? -5 : 5); } }}>
          <span className="vplayer-buf" style={{ width: `${bufPct}%` }} />
          <span className="vplayer-fill" style={{ width: `${pct}%` }} />
          <span className="vplayer-knob" style={{ left: `${pct}%` }} />
          {hover && <span className="vplayer-tip" style={{ left: `${hover.x}%` }}>{fmtDuration(hover.t)}</span>}
        </div>
        <div className="vplayer-row">
          <button className="icon-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <IconPause /> : <IconPlay />}</button>
          <button className="icon-btn hide-xs" onClick={() => seekBy(-10)} aria-label="Back 10 seconds"><IconBack10 /></button>
          <button className="icon-btn hide-xs" onClick={() => seekBy(10)} aria-label="Forward 10 seconds"><IconFwd10 /></button>
          <div className="vplayer-vol">
            <button className="icon-btn" onClick={() => { v().muted = !v().muted; }} aria-label={muted ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <IconMute /> : <IconVolume />}</button>
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={e => { v().volume = Number(e.target.value); v().muted = Number(e.target.value) === 0; }} aria-label="Volume" className="hide-sm" />
          </div>
          <span className="vplayer-time mono" data-testid="video-time">{fmtDuration(time)} / {fmtDuration(duration)}</span>
          <span className="spacer" />
          <select className="vplayer-speed" value={speed} onChange={e => { const s = Number(e.target.value); v().playbackRate = s; setSpeed(s); }} aria-label="Playback speed">
            {SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
          </select>
          {'pictureInPictureEnabled' in document && <button className="icon-btn hide-xs" onClick={pip} aria-label="Picture in picture"><IconPip /></button>}
          <button className="icon-btn" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>{fullscreen ? <IconShrink /> : <IconExpand />}</button>
        </div>
      </div>
    </div>
  );
}
