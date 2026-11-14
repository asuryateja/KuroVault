import { useEffect, useRef, useState } from 'react';
import { IconBack10, IconFwd10, IconMute, IconPause, IconPlay, IconVolume } from '../icons';
import { fmtDuration } from '../media';

/** Audio player with a live frequency visualizer driven by the actual audio signal. */
export function AudioPlayer({ src, title, artist, cover }: { src: string; title: string; artist?: string | null; cover?: string | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [error, setError] = useState('');
  const [coverOk, setCoverOk] = useState(Boolean(cover));

  function ensureGraph() {
    if (graph.current || !audio.current) return;
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audio.current);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      graph.current = { ctx, analyser };
    } catch { /* visualizer is optional */ }
  }

  async function toggle() {
    const el = audio.current!;
    ensureGraph();
    await graph.current?.ctx.resume().catch(() => undefined);
    if (el.paused) await el.play().catch(() => undefined); else el.pause();
  }

  useEffect(() => {
    const el = audio.current!;
    const on: [string, () => void][] = [
      ['timeupdate', () => setTime(el.currentTime)], ['loadedmetadata', () => setDuration(el.duration)], ['durationchange', () => setDuration(el.duration)],
      ['play', () => setPlaying(true)], ['pause', () => setPlaying(false)], ['ended', () => setPlaying(false)],
      ['volumechange', () => { setMuted(el.muted); setVolume(el.volume); }],
      ['error', () => setError('This audio could not be played in the browser. Download it to listen locally.')],
    ];
    on.forEach(([e, h]) => el.addEventListener(e, h));
    void toggle();
    return () => {
      on.forEach(([e, h]) => el.removeEventListener(e, h));
      void graph.current?.ctx.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth * dpr;
      const h = c.clientHeight * dpr;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, w, h);
      const bins = 48;
      const data = new Uint8Array(256);
      if (graph.current && playing) graph.current.analyser.getByteFrequencyData(data);
      const gap = 3 * dpr;
      const bw = (w - gap * (bins - 1)) / bins;
      for (let i = 0; i < bins; i += 1) {
        // Logarithmic spread: low bins get their own bars, highs are grouped, like a spectrum analyser.
        const lo = Math.floor(Math.pow(180, i / bins));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(180, (i + 1) / bins)));
        let peak = 0;
        for (let b = lo; b < hi && b < 256; b += 1) peak = Math.max(peak, data[b]);
        const value = peak / 255;
        const idleWave = playing ? 0 : 0.06 + 0.04 * Math.sin(i / 3);
        const bh = Math.max(2 * dpr, (value || idleWave) * h * 0.92);
        g.fillStyle = `rgba(250,250,250,${0.25 + (value || idleWave) * 0.75})`;
        g.beginPath();
        g.roundRect?.(i * (bw + gap), (h - bh) / 2, bw, bh, 2 * dpr);
        g.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const pct = duration ? (time / duration) * 100 : 0;
  return (
    <div className="aplayer" data-testid="audio-player">
      <audio ref={audio} src={src} preload="metadata" />
      <div className={`aplayer-cover ${playing ? 'is-playing' : ''}`}>
        {cover && coverOk ? <img src={cover} alt="" onError={() => setCoverOk(false)} /> : <img src="/logo.svg" alt="" className="aplayer-mark" />}
      </div>
      <div className="aplayer-meta">
        <h3 data-testid="audio-title">{title}</h3>
        {artist && <p>{artist}</p>}
      </div>
      <canvas ref={canvas} className="aplayer-viz" aria-hidden="true" data-testid="audio-viz" />
      {error && <div className="vplayer-error static" role="alert">{error}</div>}
      <div className="aplayer-seek">
        <span className="mono">{fmtDuration(time)}</span>
        <input type="range" min={0} max={duration || 0} step={0.1} value={time} onChange={e => { audio.current!.currentTime = Number(e.target.value); }} aria-label="Seek" style={{ ['--pct' as string]: `${pct}%` }} />
        <span className="mono">{fmtDuration(duration)}</span>
      </div>
      <div className="aplayer-controls">
        <button className="icon-btn" onClick={() => { audio.current!.currentTime = Math.max(0, time - 10); }} aria-label="Back 10 seconds"><IconBack10 /></button>
        <button className="play-btn" onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <IconPause width={24} height={24} /> : <IconPlay width={24} height={24} />}</button>
        <button className="icon-btn" onClick={() => { audio.current!.currentTime = Math.min(duration, time + 10); }} aria-label="Forward 10 seconds"><IconFwd10 /></button>
      </div>
      <div className="aplayer-vol">
        <button className="icon-btn" onClick={() => { audio.current!.muted = !muted; }} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? <IconMute /> : <IconVolume />}</button>
        <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={e => { audio.current!.volume = Number(e.target.value); audio.current!.muted = false; }} aria-label="Volume" />
      </div>
    </div>
  );
}
