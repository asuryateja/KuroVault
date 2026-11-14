export type DriveFile = { id: number; folder_id: number | null; name: string; size: number; mime_type: string; created_at: string; encrypted: boolean; protected?: boolean; forwarded?: boolean; caption?: string;
  /** Custom URLs, e.g. for a file inside an archive. null hides that action. */
  src?: { stream: string; download: string | null; thumb: string | null; info: string | null };
  /** Telegram: the video codec, and other encodings of the same video Telegram keeps. */
  video_codec?: string | null;
  variants?: { index: number; codec: string | null; width: number | null; height: number | null; size: number; mime: string }[] };
export type MediaKind = 'video' | 'audio' | 'image' | 'pdf' | 'archive' | 'encrypted' | 'other';

const EXT: Record<string, MediaKind> = {
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', wav: 'audio', flac: 'audio', weba: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image',
  pdf: 'pdf',
  zip: 'archive', cbz: 'archive', rar: 'archive', cbr: 'archive',
};
const ARCHIVE_MIME = new Set(['application/zip', 'application/x-zip-compressed', 'application/vnd.rar', 'application/x-rar-compressed', 'application/x-rar', 'application/vnd.comicbook+zip', 'application/vnd.comicbook-rar']);

export function kindOf(f: DriveFile): MediaKind {
  const mime = (f.mime_type || '').toLowerCase();
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  let kind: MediaKind = 'other';
  if (mime === 'application/pdf') kind = 'pdf';
  else if (ARCHIVE_MIME.has(mime) || (EXT[ext] === 'archive' && !f.src)) kind = 'archive';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('audio/')) kind = 'audio';
  else if (mime.startsWith('image/') && mime !== 'image/svg+xml') kind = 'image';
  else if (!mime || mime === 'application/octet-stream') kind = EXT[ext] ?? 'other';
  if (kind === 'archive' && f.src) kind = 'other'; // archives inside archives are offered as downloads
  if (kind !== 'other' && f.encrypted) return 'encrypted';
  return kind;
}

const q = (f: DriveFile) => (f.folder_id !== null ? `?folder_id=${f.folder_id}` : '');

// Codec strings browsers understand, used to ask "can you decode this?" before choosing a version.
const CODEC_TYPES: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640028"', avc: 'video/mp4; codecs="avc1.640028"', avc1: 'video/mp4; codecs="avc1.640028"',
  h265: 'video/mp4; codecs="hvc1.1.6.L120.90"', hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"', hvc1: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  av1: 'video/mp4; codecs="av01.0.08M.08"', av01: 'video/mp4; codecs="av01.0.08M.08"',
  vp9: 'video/webm; codecs="vp9"', vp8: 'video/webm; codecs="vp8"',
};
let probe: HTMLVideoElement | null = null;
/** true = can play, false = cannot, null = unknown codec (try it). */
export function canDecode(codec: string | null | undefined): boolean | null {
  if (!codec) return null;
  const type = CODEC_TYPES[codec.toLowerCase()];
  if (!type) return null;
  probe ??= document.createElement('video');
  return probe.canPlayType(type) !== '';
}
/** Which version to stream: the original if this browser can decode it, otherwise a Telegram alternative it can. */
export function pickVariant(f: DriveFile): number | null {
  if (!f.variants?.length || canDecode(f.video_codec) !== false) return null;
  const playable = f.variants.filter(v => canDecode(v.codec) === true).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return playable[0]?.index ?? null;
}
export const streamUrl = (f: DriveFile) => {
  if (f.src) return f.src.stream;
  const variant = pickVariant(f);
  const base = `/api/drive/files/${f.id}/stream${q(f)}`;
  return variant === null ? base : `${base}${base.includes('?') ? '&' : '?'}variant=${variant}`;
};
export const downloadUrl = (f: DriveFile) => (f.src ? f.src.download : `/api/drive/files/${f.id}/download${q(f)}`);
export const thumbUrl = (f: DriveFile) => (f.src ? f.src.thumb : `/api/drive/files/${f.id}/thumbnail${q(f)}`);
export const infoUrl = (f: DriveFile) => (f.src ? f.src.info : `/api/drive/files/${f.id}/media-info${q(f)}`);
/** Smooth playback preparation for a Telegram video (same quality the player would stream). */
export const prepareUrl = (f: DriveFile) => streamUrl(f).replace('/stream', '/prepare');
export const isTelegramFile = (f: DriveFile) => Array.isArray(f.variants) && !f.src;
export const archiveUrl = (f: DriveFile) => `/api/archive/${f.id}${q(f)}`;

export function fmtDuration(s: number | null | undefined) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '0:00';
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const KIND_LABEL: Record<MediaKind, string> = { video: 'Video', audio: 'Audio', image: 'Image', pdf: 'PDF', archive: 'Archive', encrypted: 'Encrypted', other: 'File' };
