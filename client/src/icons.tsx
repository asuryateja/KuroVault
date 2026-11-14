// Minimal stroke icon set (24px grid), inherits currentColor.
import type { ReactNode, SVGProps } from 'react';

const base = (d: ReactNode, props: SVGProps<SVGSVGElement>) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{d}</svg>
);
type P = SVGProps<SVGSVGElement>;

export const IconPlay = (p: P) => base(<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />, p);
export const IconPause = (p: P) => base(<><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>, p);
export const IconVolume = (p: P) => base(<><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>, p);
export const IconMute = (p: P) => base(<><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="m16 9.5 5 5m0-5-5 5" /></>, p);
export const IconExpand = (p: P) => base(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />, p);
export const IconShrink = (p: P) => base(<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />, p);
export const IconPip = (p: P) => base(<><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" /></>, p);
export const IconClose = (p: P) => base(<path d="M6 6l12 12M18 6 6 18" />, p);
export const IconPrev = (p: P) => base(<path d="M15 5 8 12l7 7" />, p);
export const IconNext = (p: P) => base(<path d="m9 5 7 7-7 7" />, p);
export const IconDownload = (p: P) => base(<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />, p);
export const IconZoomIn = (p: P) => base(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M11 8v6M8 11h6" /></>, p);
export const IconZoomOut = (p: P) => base(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M8 11h6" /></>, p);
export const IconFit = (p: P) => base(<path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M8 20H5a1 1 0 0 1-1-1v-3M16 20h3a1 1 0 0 0 1-1v-3" />, p);
export const IconBack10 = (p: P) => base(<><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" /><path d="M4 4v4.5h4.5" /><text x="12" y="15.5" fontSize="7" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="sans-serif">10</text></>, p);
export const IconFwd10 = (p: P) => base(<><path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5" /><path d="M20 4v4.5h-4.5" /><text x="12" y="15.5" fontSize="7" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="sans-serif">10</text></>, p);
export const IconGrid = (p: P) => base(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>, p);
export const IconList = (p: P) => base(<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />, p);
export const IconMenu = (p: P) => base(<path d="M4 7h16M4 12h16M4 17h16" />, p);
export const IconLock = (p: P) => base(<><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 1 1 8 0v2.5" /></>, p);
export const IconFile = (p: P) => base(<><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" /></>, p);
export const IconFilm = (p: P) => base(<><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4" /></>, p);
export const IconWave = (p: P) => base(<path d="M4 12h1.5M7.5 8v8M11 5v14M14.5 9v6M18 7v10M20.5 12H20" />, p);
export const IconImage = (p: P) => base(<><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5-5 4 4 2.5-2.5L20 19" /></>, p);
export const IconPdf = (p: P) => base(<><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5M8.5 15.5h7M8.5 12.5h7" /></>, p);
export const IconArchive = (p: P) => base(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M10.5 4v2h3M10.5 8h3M10.5 10h3" /><rect x="10" y="12.5" width="4" height="4" rx="1" /></>, p);
export const IconFolder = (p: P) => base(<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />, p);
export const IconUpload = (p: P) => base(<path d="M12 19V8m0 0-4.5 4.5M12 8l4.5 4.5M5 4.5h14" />, p);
export const IconTrash = (p: P) => base(<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7" />, p);
export const IconSun = (p: P) => base(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>, p);
export const IconMoon = (p: P) => base(<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />, p);
