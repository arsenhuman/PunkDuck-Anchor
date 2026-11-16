// In-memory fake of the Drive REST endpoints used by DriveStore.
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';

export function createFakeDriveApi({ failChunkTimes = 0 } = {}) {
  const files = new Map(); // id -> {id,name,mimeType,parents,appProperties,createdTime,data}
  const sessions = new Map();
  const calls = [];
  let seq = 0;
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let chunkFailures = failChunkTimes;

  const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
  const view = (f) => ({
    id: f.id, name: f.name, createdTime: f.createdTime, appProperties: f.appProperties,
    size: f.data ? String(f.data.length) : undefined,
    md5Checksum: f.data ? crypto.createHash('md5').update(f.data).digest('hex') : undefined,
  });

  function matches(f, q) {
    let ok = !f.trashed;
    const parent = q.match(/'([^']+)' in parents/);
    if (parent) ok &&= f.parents.includes(parent[1]);
    const name = q.match(/name = '((?:[^'\\]|\\.)*)'/);
    if (name) ok &&= f.name === name[1].replace(/\\(.)/g, '$1');
    if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) ok &&= f.mimeType.endsWith('folder');
    if (q.includes("mimeType != 'application/vnd.google-apps.folder'")) ok &&= !f.mimeType.endsWith('folder');
    if (q.includes("key='bmApp'")) ok &&= f.appProperties?.bmApp === 'backup-manager';
    return ok;
  }

  function add(meta, data) {
    const id = `id${++seq}`;
    clock += 1000;
    const f = { id, trashed: false, createdTime: new Date(clock).toISOString(), ...meta, data };
    files.set(id, f);
    return f;
  }

  async function request(o) {
    calls.push({ method: o.method, url: o.url, params: o.params, headers: o.headers });
    const vs = o.validateStatus || ((s) => s >= 200 && s < 300);
    const respond = (status, data, headers = {}) => {
      if (!vs(status)) throw Object.assign(new Error(`HTTP ${status}`), { response: { status } });
      return { status, data, headers };
    };
    const u = new URL(o.url);
    if (u.pathname === '/drive/v3/files' && o.method === 'GET') {
      return respond(200, { files: [...files.values()].filter((f) => matches(f, o.params.q)).map(view) });
    }
    if (u.pathname === '/drive/v3/files' && o.method === 'POST') {
      return respond(200, view(add({ ...o.data, mimeType: o.data.mimeType })));
    }
    if (u.pathname === '/upload/drive/v3/files' && o.method === 'POST') {
      const sid = `s${++seq}`;
      sessions.set(sid, { meta: o.data, total: Number(o.headers['X-Upload-Content-Length']), buf: Buffer.alloc(0) });
      return respond(200, {}, { location: `https://upload.example/session/${sid}` });
    }
    if (u.hostname === 'upload.example' && o.method === 'PUT') {
      const s = sessions.get(u.pathname.split('/').pop());
      if (!s) throw httpError(404);
      const cr = o.headers['Content-Range'];
      if (cr.startsWith('bytes */')) {
        if (s.done) return respond(200, s.done);
        return respond(308, undefined, s.buf.length ? { range: `bytes=0-${s.buf.length - 1}` } : {});
      }
      if (chunkFailures > 0) {
        chunkFailures--;
        // simulate a dropped connection after the server stored half the chunk
        const [, start] = cr.match(/bytes (\d+)-/);
        if (Number(start) === s.buf.length) s.buf = Buffer.concat([s.buf, o.data.subarray(0, o.data.length >> 1)]);
        throw httpError(503);
      }
      const [, start] = cr.match(/bytes (\d+)-/);
      assertEq(Number(start), s.buf.length, 'chunk must resume at server offset');
      s.buf = Buffer.concat([s.buf, o.data]);
      if (s.buf.length < s.total) return respond(308, undefined, { range: `bytes=0-${s.buf.length - 1}` });
      const f = add({ ...s.meta, parents: s.meta.parents }, s.buf);
      s.done = view(f);
      return respond(200, s.done);
    }
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m) {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) throw httpError(404);
      if (o.method === 'DELETE') {
        files.delete(f.id);
        return respond(204, '');
      }
      if (o.params?.alt === 'media') return respond(200, Readable.from([f.data]));
      return respond(200, view(f));
    }
    if (u.pathname === '/drive/v3/about') return respond(200, { user: { emailAddress: 'me@gmail.com' } });
    throw new Error(`fake drive: unhandled ${o.method} ${o.url}`);
  }

  return { request, files, calls, add };
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: ${a} != ${b}`);
}

export async function writeFile(p, data) {
  await fs.writeFile(p, data);
}
