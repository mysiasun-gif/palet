// TakJot cloud backup: encryption, Google Drive (appDataFolder) and Google sign-in.
// Browser only, no server. Nothing here logs or stores the token, the password or note text.

export const CLIENT_ID = '85892711613-u0dsilm4u0tmuhedn3kekao3tf49i6to.apps.googleusercontent.com';
export const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const ENVELOPE_APP = 'takjot-cloud';
export const KDF_ITER = 600000;
export const MIN_PASSWORD = 8;
export const KEEP_BACKUPS = 3;
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_RE = /^takjot-yedek-\d{8}-\d{4}\.json$/;

// Every failure carries a short code; the app turns codes into friendly messages.
// codes: network, auth, denied, popup-closed, popup-blocked, wrong-password, corrupt,
//        quota, notfound, server, weak-password
export class CloudError extends Error {
  constructor(code) { super(code); this.name = 'CloudError'; this.code = code; }
}

/* ---------- Encryption ---------- */
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  if (typeof str !== 'string') throw new CloudError('corrupt');
  let bin;
  try { bin = atob(str); } catch { throw new CloudError('corrupt'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || [...pw].length < MIN_PASSWORD) return `Şifre en az ${MIN_PASSWORD} karakter olmalı.`;
  if (pw.length > 1024) return 'Şifre çok uzun.';
  return null;
}

async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// data: the same object the file backup writes ({ app: 'palet', version, exportedAt, notes }).
// password: a string to encrypt, or null for an unencrypted backup.
export async function encryptBackup(data, password, { now = new Date(), iter = KDF_ITER } = {}) {
  const plain = JSON.stringify(data);
  const base = { app: ENVELOPE_APP, v: 1, createdAt: now.toISOString(), noteCount: Array.isArray(data?.notes) ? data.notes.length : 0 };
  if (password == null) return { ...base, enc: false, kdf: null, iv: null, data: plain };
  const bad = checkPassword(password);
  if (bad) throw new CloudError('weak-password');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iter);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain)));
  return {
    ...base, enc: true,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter, salt: toB64(salt) },
    iv: toB64(iv), data: toB64(cipher),
  };
}

// Reads an envelope (object or JSON text). Never touches app data; the caller decides what to do.
export function parseEnvelope(raw) {
  let env = raw;
  if (typeof raw === 'string') { try { env = JSON.parse(raw); } catch { throw new CloudError('corrupt'); } }
  if (!env || typeof env !== 'object' || env.app !== ENVELOPE_APP || env.v !== 1 || typeof env.enc !== 'boolean' || typeof env.data !== 'string') {
    throw new CloudError('corrupt');
  }
  if (env.enc) {
    const k = env.kdf;
    if (!k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iter) || k.iter < 100000 || k.iter > 10000000) {
      throw new CloudError('corrupt');
    }
    if (fromB64(k.salt).length !== 16 || fromB64(env.iv).length !== 12) throw new CloudError('corrupt');
  }
  return env;
}

export async function decryptBackup(raw, password) {
  const env = parseEnvelope(raw);
  let plain;
  if (!env.enc) {
    plain = env.data;
  } else {
    if (typeof password !== 'string' || !password) throw new CloudError('wrong-password');
    const key = await deriveKey(password, fromB64(env.kdf.salt), env.kdf.iter);
    let bytes;
    try {
      bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.data));
    } catch {
      // AES-GCM cannot tell a wrong password from a damaged file; a wrong password is far likelier.
      throw new CloudError('wrong-password');
    }
    plain = dec.decode(bytes);
  }
  let data;
  try { data = JSON.parse(plain); } catch { throw new CloudError('corrupt'); }
  const notes = Array.isArray(data) ? data : data?.notes;
  if (!Array.isArray(notes)) throw new CloudError('corrupt');
  return data;
}

/* ---------- Drive ---------- */
const pad = n => String(n).padStart(2, '0');
export function backupFileName(d = new Date()) {
  return `takjot-yedek-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

async function errorCode(res) {
  if (res.status === 401) return 'auth';
  if (res.status === 404) return 'notfound';
  if (res.status === 403) {
    let reason = '';
    try { const j = await res.json(); reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? ''; } catch { /* no body */ }
    if (/storageQuota|quotaExceeded/i.test(reason)) return 'quota';
    if (/rateLimit/i.test(reason)) return 'server';
    return 'denied';
  }
  return 'server';
}

// fetchFn: window.fetch or a test double. getToken(): current access token or null.
// refreshToken(): try once, quietly, to get a new token; resolves to the token or throws.
export function createDrive({ fetchFn, getToken, refreshToken }) {
  async function request(url, opts = {}, { json = true } = {}) {
    let token = getToken();
    if (!token) throw new CloudError('auth');
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
      } catch {
        throw new CloudError('network');
      }
      if (res.status === 401 && attempt === 0) {
        try { token = await refreshToken(); } catch { throw new CloudError('auth'); }
        if (!token) throw new CloudError('auth');
        continue;
      }
      if (!res.ok) throw new CloudError(await errorCode(res));
      if (!json) return res;
      if (res.status === 204) return null;
      try { return await res.json(); } catch { return null; }
    }
  }

  const mine = f => f && FILE_RE.test(f.name) && f.appProperties?.app === ENVELOPE_APP;
  const describe = f => ({
    id: f.id, name: f.name,
    createdAt: Date.parse(f.appProperties?.createdAt ?? f.createdTime) || Date.parse(f.createdTime) || 0,
    noteCount: Number(f.appProperties?.noteCount) || 0,
    enc: f.appProperties?.enc !== '0',
  });

  async function list() {
    const q = encodeURIComponent("name contains 'takjot-yedek-' and trashed = false");
    const fields = encodeURIComponent('files(id,name,createdTime,appProperties)');
    const data = await request(`${API}/files?spaces=appDataFolder&q=${q}&fields=${fields}&orderBy=createdTime%20desc&pageSize=100`);
    return (data?.files ?? []).filter(mine).map(describe).sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  }

  async function create(envelope, now = new Date()) {
    const boundary = `takjot${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
    const meta = {
      name: backupFileName(now),
      parents: ['appDataFolder'],
      mimeType: 'application/json',
      appProperties: { app: ENVELOPE_APP, noteCount: String(envelope.noteCount), enc: envelope.enc ? '1' : '0', createdAt: envelope.createdAt },
    };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(envelope)}\r\n--${boundary}--`;
    const fields = encodeURIComponent('id,name,createdTime,appProperties');
    const f = await request(`${UPLOAD}/files?uploadType=multipart&fields=${fields}`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    if (!f?.id) throw new CloudError('server');
    return describe({ ...f, appProperties: f.appProperties ?? meta.appProperties, name: f.name ?? meta.name });
  }

  async function download(id) {
    const res = await request(`${API}/files/${encodeURIComponent(id)}?alt=media`, {}, { json: false });
    let text;
    try { text = await res.text(); } catch { throw new CloudError('network'); }
    return parseEnvelope(text);
  }

  const remove = id => request(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, { json: false });

  // Keep the newest KEEP_BACKUPS of our own files (always including keepId); delete the rest.
  async function prune(keepId) {
    const files = await list();
    const ordered = [...files.filter(f => f.id === keepId), ...files.filter(f => f.id !== keepId)];
    const extra = ordered.slice(KEEP_BACKUPS);
    let removed = 0;
    for (const f of extra) {
      try { await remove(f.id); removed++; } catch { /* an old copy left behind is harmless */ }
    }
    return removed;
  }

  async function email() {
    try {
      const j = await request(`${API}/about?fields=${encodeURIComponent('user(emailAddress)')}`);
      return j?.user?.emailAddress ?? null;
    } catch (e) {
      if (e.code === 'network' || e.code === 'auth') throw e;
      return null;
    }
  }

  return { list, create, download, remove, prune, email };
}

/* ---------- Google sign-in (Identity Services, token model) ---------- */
let gisPromise = null;
export const gisReady = () => !!globalThis.google?.accounts?.oauth2;
// Loaded only when the user first uses a cloud feature.
export function loadGis() {
  if (gisReady()) return Promise.resolve();
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => (gisReady() ? resolve() : reject(new CloudError('network')));
    s.onerror = () => { s.remove(); gisPromise = null; reject(new CloudError('network')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

// The access token lives only in this closure, never in storage.
export function createAuth({ clientId = CLIENT_ID, scope = SCOPE, now = () => Date.now() } = {}) {
  let token = null;
  let expiresAt = 0;
  let client = null;
  let pending = null;

  function settle(fn, value) { const p = pending; pending = null; if (p) p[fn](value); }

  function getClient() {
    if (client) return client;
    const oauth2 = globalThis.google.accounts.oauth2;
    client = oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: resp => {
        if (!resp || resp.error) {
          settle('reject', new CloudError(resp?.error === 'access_denied' ? 'denied' : 'auth'));
          return;
        }
        const granted = oauth2.hasGrantedAllScopes ? oauth2.hasGrantedAllScopes(resp, scope) : String(resp.scope || '').includes(scope);
        if (!granted || !resp.access_token) { settle('reject', new CloudError('denied')); return; }
        token = resp.access_token;
        expiresAt = now() + (Number(resp.expires_in) || 3600) * 1000;
        settle('resolve', token);
      },
      error_callback: err => {
        const t = err?.type;
        settle('reject', new CloudError(t === 'popup_closed' ? 'popup-closed' : t === 'popup_failed_to_open' ? 'popup-blocked' : 'auth'));
      },
    });
    return client;
  }

  // Must be called straight from a user's tap (no await before it), or the browser blocks the window.
  // quiet: ask without the account chooser, for a silent refresh.
  function request({ quiet = false, hint } = {}) {
    if (!gisReady()) return Promise.reject(new CloudError('network'));
    if (pending) settle('reject', new CloudError('popup-closed'));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      const opts = {};
      if (quiet) opts.prompt = '';
      if (hint) opts.login_hint = hint;
      try {
        getClient().requestAccessToken(opts);
      } catch {
        settle('reject', new CloudError('popup-blocked'));
      }
    });
  }

  const valid = () => !!token && now() < expiresAt - 60000;
  return {
    request,
    valid,
    token: () => (valid() ? token : null),
    clear() { token = null; expiresAt = 0; },
    revoke() {
      const t = token;
      token = null; expiresAt = 0;
      if (t && gisReady()) { try { globalThis.google.accounts.oauth2.revoke(t, () => {}); } catch { /* already gone */ } }
    },
  };
}
