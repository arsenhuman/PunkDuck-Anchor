// Minimal Google Drive v3 client on top of an authorized `request` function
// (google-auth-library's OAuth2Client#request or a test fake).

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const APP_TAG = { key: 'bmApp', value: 'backup-manager' };
const FILE_FIELDS = 'id,name,size,createdTime,appProperties,md5Checksum';
const CHUNK_UNIT = 256 * 1024;

export function escapeQuery(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function header(res, name) {
  const h = res?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function isRetryable(err) {
  const status = err?.response?.status ?? err?.status;
  if (status) {
    if (status === 429 || status >= 500) return true;
    if (status === 403) {
      const errors = err.response?.data?.error?.errors ?? [];
      return errors.some((e) => RATE_LIMIT_REASONS.has(e.reason));
    }
    return false;
  }
  // No HTTP status: retry only genuine network failures, never programming errors.
  const code = err?.code ?? err?.cause?.code;
  return NETWORK_CODES.has(code) || err?.type === 'request-timeout' || err?.name === 'AbortError';
}

export class DriveStore {
  /**
   * @param {object} o
   * @param {(opts:object)=>Promise<{status:number,data:any,headers:any}>} o.request
   */
  constructor({ request, chunkSize = 32 * CHUNK_UNIT, maxRetries = 5, retryDelayMs = 1000, logger } = {}) {
    if (chunkSize % CHUNK_UNIT !== 0) throw new Error('chunkSize must be a multiple of 256 KiB');
    this.request = request;
    this.chunkSize = chunkSize;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.logger = logger;
    this.folderCache = new Map();
  }

  async #withRetry(what, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryable(err)) throw err;
        const delay = this.retryDelayMs * 2 ** attempt + Math.floor(Math.random() * this.retryDelayMs);
        this.logger?.warn(`${what} failed, retrying`, { attempt: attempt + 1, delayMs: delay, error: err });
        await sleep(delay);
      }
    }
  }

  async #listAll(q, fields = FILE_FIELDS) {
    const files = [];
    let pageToken;
    do {
      const res = await this.#withRetry('drive list', () =>
        this.request({
          url: `${API}/files`,
          method: 'GET',
          params: { q, fields: `nextPageToken,files(${fields})`, pageSize: 1000, spaces: 'drive', pageToken },
        }),
      );
      files.push(...(res.data.files || []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
  }

  async findFolder(name, parentId) {
    const q = `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and '${escapeQuery(parentId)}' in parents and trashed = false`;
    const found = await this.#listAll(q, 'id,name,createdTime');
    found.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime)); // deterministic if duplicates exist
    return found[0]?.id ?? null;
  }

  async ensureFolder(name, parentId = 'root') {
    const cacheKey = `${parentId}/${name}`;
    if (this.folderCache.has(cacheKey)) return this.folderCache.get(cacheKey);
    let id = await this.findFolder(name, parentId);
    if (!id) {
      const res = await this.#withRetry('drive create folder', () =>
        this.request({
          url: `${API}/files`,
          method: 'POST',
          params: { fields: 'id' },
          data: { name, mimeType: FOLDER_MIME, parents: [parentId] },
        }),
      );
      id = res.data.id;
    }
    this.folderCache.set(cacheKey, id);
    return id;
  }

  async ensurePath(names) {
    let parent = 'root';
    for (const n of names) parent = await this.ensureFolder(n, parent);
    return parent;
  }

  /** Resolve a path without creating anything; null if any segment is missing. */
  async resolvePath(names) {
    let parent = 'root';
    for (const n of names) {
      parent = await this.findFolder(n, parent);
      if (!parent) return null;
    }
    return parent;
  }

  async listSubfolders(parentId) {
    const q = `mimeType = '${FOLDER_MIME}' and '${escapeQuery(parentId)}' in parents and trashed = false`;
    return this.#listAll(q, 'id,name,createdTime');
  }

  /** Backup files (created by this tool) directly inside folderId. */
  async listBackups(folderId) {
    const q = `'${escapeQuery(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}' and appProperties has { key='${APP_TAG.key}' and value='${APP_TAG.value}' }`;
    const files = await this.#listAll(q);
    return files.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
  }

  async getFile(fileId) {
    const res = await this.request({ url: `${API}/files/${encodeURIComponent(fileId)}`, method: 'GET', params: { fields: FILE_FIELDS } });
    return res.data;
  }

  async deleteFile(fileId) {
    await this.#withRetry('drive delete', () =>
      this.request({ url: `${API}/files/${encodeURIComponent(fileId)}`, method: 'DELETE' }),
    );
  }

  async download(fileId, destPath) {
    await this.#withRetry('drive download', async () => {
      const res = await this.request({
        url: `${API}/files/${encodeURIComponent(fileId)}`,
        method: 'GET',
        params: { alt: 'media' },
        responseType: 'stream',
      });
      await pipeline(res.data, fs.createWriteStream(destPath, { mode: 0o600 }));
    });
  }

  /** Chunked resumable upload with retry/resume. Returns the created file resource. */
  async uploadResumable({ filePath, name, parentId, appProperties = {}, mimeType = 'application/octet-stream' }) {
    const { size } = await fs.promises.stat(filePath);
    const init = await this.#withRetry('drive upload init', () =>
      this.request({
        url: `${UPLOAD_API}/files`,
        method: 'POST',
        params: { uploadType: 'resumable', fields: FILE_FIELDS },
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size),
        },
        data: { name, parents: [parentId], mimeType, appProperties: { ...appProperties, [APP_TAG.key]: APP_TAG.value } },
      }),
    );
    const session = header(init, 'location');
    if (!session) throw new Error('Drive did not return a resumable upload session URL');

    const fh = await fs.promises.open(filePath, 'r');
    try {
      let offset = 0;
      let failures = 0;
      let stalls = 0;
      for (;;) {
        const end = Math.min(offset + this.chunkSize, size);
        const buf = Buffer.alloc(end - offset);
        if (buf.length) await fh.read(buf, 0, buf.length, offset);
        const range = size === 0 ? 'bytes */0' : `bytes ${offset}-${end - 1}/${size}`;
        let res;
        try {
          res = await this.request({
            url: session,
            method: 'PUT',
            headers: { 'Content-Range': range, 'Content-Type': mimeType },
            data: buf,
            validateStatus: (s) => (s >= 200 && s < 300) || s === 308,
          });
        } catch (err) {
          const status = err?.response?.status;
          if (status === 404 || status === 410) throw new Error('upload session expired; backup must be re-uploaded');
          if (!isRetryable(err) || ++failures > this.maxRetries) throw err;
          const delay = this.retryDelayMs * 2 ** (failures - 1);
          this.logger?.warn('upload chunk failed, resuming', { offset, attempt: failures, delayMs: delay, error: err });
          await sleep(delay);
          const status2 = await this.#queryUploadStatus(session, size);
          if (status2.done) return status2.file;
          offset = status2.offset;
          continue;
        }
        if (res.status === 308) {
          const r = header(res, 'range');
          const next = r ? Number(r.split('-')[1]) + 1 : 0;
          if (next <= offset) {
            // Server accepted nothing new; don't loop forever.
            if (++stalls > this.maxRetries) throw new Error(`upload made no progress at byte ${offset}`);
          } else {
            stalls = 0;
            failures = 0;
          }
          offset = next;
          continue;
        }
        return res.data;
      }
    } finally {
      await fh.close();
    }
  }

  async #queryUploadStatus(session, size) {
    const res = await this.#withRetry('upload status', () =>
      this.request({
        url: session,
        method: 'PUT',
        headers: { 'Content-Range': `bytes */${size}` },
        validateStatus: (s) => (s >= 200 && s < 300) || s === 308,
      }),
    );
    if (res.status !== 308) return { done: true, file: res.data }; // server already has everything
    const r = header(res, 'range');
    return { done: false, offset: r ? Number(r.split('-')[1]) + 1 : 0 };
  }
}
