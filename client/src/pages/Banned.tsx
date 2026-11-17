// Full-screen takeover shown to a blocked visitor. Manga "forbidden" splash: a stamped seal,
// a slashed banner, a halftone burst. Deliberately gives no detail beyond "blocked".
function untilText(until: number | null) {
  if (!until || until >= 4_100_000_000_000) return 'This block stays in place until an administrator lifts it.';
  const ms = until - Date.now();
  if (ms <= 0) return 'This block has just expired — refresh the page.';
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `Access is blocked for about ${hours} more hour${hours === 1 ? '' : 's'}.`;
  return `Access is blocked for about ${Math.ceil(hours / 24)} more days.`;
}

export function BannedScreen({ until }: { until: number | null }) {
  return (
    <div className="banned" role="alert" aria-label="Access blocked">
      <svg className="banned-art" viewBox="0 0 520 520" aria-hidden="true">
        <defs>
          <radialGradient id="bfade" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#e9e4d8" /><stop offset="0.6" stopColor="#e9e4d8" stopOpacity="0.5" /><stop offset="1" stopColor="#e9e4d8" stopOpacity="0" /></radialGradient>
          <mask id="bburst"><circle cx="260" cy="260" r="250" fill="url(#bfade)" /></mask>
          <pattern id="btone" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="6" cy="6" r="3" fill="#e9e4d8" /></pattern>
        </defs>
        <rect width="520" height="520" fill="url(#btone)" mask="url(#bburst)" opacity="0.14" />
        <g className="banned-rays" stroke="#e9e4d8" strokeLinecap="round" opacity="0.4">
          {Array.from({ length: 24 }, (_, i) => <line key={i} x1="260" y1="260" x2="260" y2="-10" strokeWidth={i % 3 === 0 ? 3 : 1} strokeDasharray="30 260" transform={`rotate(${i * 15} 260 260)`} />)}
        </g>
        <circle className="banned-seal" cx="260" cy="260" r="150" fill="none" stroke="#e9e4d8" strokeWidth="6" />
        <circle className="banned-seal" cx="260" cy="260" r="128" fill="none" stroke="#e9e4d8" strokeWidth="2" strokeDasharray="4 10" />
        <line className="banned-slash" x1="150" y1="150" x2="370" y2="370" stroke="#e9e4d8" strokeWidth="14" strokeLinecap="round" />
      </svg>
      <div className="banned-copy">
        <span className="banned-kicker">アクセス禁止 · Access denied</span>
        <h1 className="banned-title">BANNED</h1>
        <p className="banned-sub">You have been blocked from Kurovault.</p>
        <p className="banned-until">{untilText(until)}</p>
      </div>
    </div>
  );
}
