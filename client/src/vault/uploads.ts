// Resumable chunked uploads: small chunks pass any proxy/tunnel size cap; each chunk is
// retried on network errors and the server tells us where to resume.
import { api, getCsrf } from '../api';

export type UploadItem = { key: string; name: string; size: number; sent: number; status: 'queued' | 'uploading' | 'finishing' | 'done' | 'error' | 'cancelled'; error?: string };

function putChunk(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', getCsrf());
    xhr.upload.onprogress = e => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let message = `Upload failed (${xhr.status})`;
        try { message = JSON.parse(xhr.responseText).error.message; } catch { /* keep default */ }
        reject(Object.assign(new Error(message), { status: xhr.status }));
      }
    };
    xhr.onerror = () => reject(Object.assign(new Error('Network error'), { status: 0 }));
    signal.addEventListener('abort', () => { xhr.abort(); reject(Object.assign(new Error('Cancelled'), { status: -1 })); }, { once: true });
    xhr.send(blob);
  });
}

export async function uploadFile(file: File, folderId: string | null, onUpdate: (patch: Partial<UploadItem>) => void, signal: AbortSignal) {
  const init = await api<{ id: string; chunkSize: number; chunks: number }>('/api/drive/uploads', { method: 'POST', body: { name: file.name, size: file.size, folder_id: folderId } });
  const base = `/api/drive/uploads/${init.id}`;
  let index = 0;
  try {
    onUpdate({ status: 'uploading' });
    while (index < init.chunks) {
      const blob = file.slice(index * init.chunkSize, Math.min(file.size, (index + 1) * init.chunkSize));
      let attempt = 0;
      for (;;) {
        try {
          await putChunk(`${base}/chunks/${index}`, blob, loaded => onUpdate({ sent: index * init.chunkSize + loaded }), signal);
          break;
        } catch (error) {
          const status = (error as { status?: number }).status ?? 0;
          if (status === -1 || attempt >= 4 || (status >= 400 && status < 500 && status !== 409 && status !== 408 && status !== 429)) throw error;
          attempt += 1;
          await new Promise(r => setTimeout(r, 800 * attempt));
          const state = await api<{ nextIndex: number }>(base);
          if (state.nextIndex > index) break;
        }
      }
      index += 1;
      onUpdate({ sent: Math.min(file.size, index * init.chunkSize) });
    }
    onUpdate({ status: 'finishing', sent: file.size });
    await api(`${base}/complete`, { method: 'POST', body: {} });
    onUpdate({ status: 'done' });
  } catch (error) {
    void api(base, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}
