// TakJot hidden notes: note content locked with a key that only the user's password
// (or, where the device truly supports it, a platform authenticator's PRF secret) can open.
// Web Crypto only, no library, no network. Nothing here logs or stores a password, a key or note text.
//
// How the keys fit together:
//   password --PBKDF2-SHA256 (600k, 16-byte salt)--> wrapping key (AES-GCM 256, not extractable)
//   wrapping key unwraps the note key (AES-GCM 256), which is unwrapped as not extractable
//   note key encrypts each hidden note (title, text, list items together, fresh 12-byte IV)
//   a "check block" (a known text encrypted with the note key) confirms the right key was opened.
// Only the salt, the wrapped note key and the check block are saved. Never the password or a key.

export const VAULT_ITER = 600000;
// New passwords: at least 8 characters; a password of digits only needs at least 10.
// Only new or changed passwords are checked; existing ones keep opening their notes.
export const MIN_SECRET = 8;
export const MIN_SECRET_DIGITS = 10;
export const SECRET_RULE = 'En az 8 karakter olmalı (sadece rakamsa 10).';
const CHECK_TEXT = 'takjot-gizli-not-kontrol-v1';
const BIO_INFO = 'takjot-gizli-not-biyometrik-v1';

// codes: wrong-password, corrupt, weak-password, mismatch, locked
export class VaultError extends Error {
  constructor(code) { super(code); this.name = 'VaultError'; this.code = code; }
}

const te = new TextEncoder();
const td = new TextDecoder();
const AES = { name: 'AES-GCM', length: 256 };

export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str) {
  if (typeof str !== 'string') throw new VaultError('corrupt');
  let bin;
  try { bin = atob(str); } catch { throw new VaultError('corrupt'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const random = n => crypto.getRandomValues(new Uint8Array(n));
const newKid = () => toB64(random(12)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));

/* ---------- Password rules and strength ---------- */
export function checkSecretPassword(pw) {
  if (typeof pw !== 'string') return SECRET_RULE;
  const len = [...pw].length;
  if (len < MIN_SECRET || (/^\p{Nd}+$/u.test(pw) && len < MIN_SECRET_DIGITS)) return SECRET_RULE;
  if (pw.length > 1024) return 'Şifre çok uzun.';
  return null;
}
// 0: too short, 1: weak, 2: fair, 3: strong. Simple on purpose: length and kinds of characters.
export function passwordStrength(pw = '') {
  const len = [...pw].length;
  const kinds = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}]/u].filter(r => r.test(pw)).length;
  const digitsOnly = /^\p{Nd}+$/u.test(pw);
  let score;
  if (checkSecretPassword(pw)) score = 0;
  else if (digitsOnly || len < 8 || kinds < 2) score = 1;
  else if ((len >= 10 && kinds >= 3) || (len >= 14 && kinds >= 2)) score = 3;
  else score = 2;
  return { score, label: ['Yetersiz', 'Zayıf', 'Orta', 'Güçlü'][score] };
}

/* ---------- Wrong-password waits ---------- */
// After 5 wrong tries in a row, each further wrong try waits longer.
const WAITS = [30, 60, 300, 900, 1800, 3600];
export const lockDelay = fails => (fails < 5 ? 0 : WAITS[Math.min(fails - 5, WAITS.length - 1)] * 1000);
export function cleanLock(raw) {
  const fails = Number.isInteger(raw?.fails) && raw.fails > 0 ? raw.fails : 0;
  const until = Number.isFinite(raw?.until) && raw.until > 0 ? raw.until : 0;
  return { fails, until };
}
export const lockRemaining = (lock, now = Date.now()) => Math.max(0, cleanLock(lock).until - now);
export function failedTry(lock, now = Date.now()) {
  const fails = cleanLock(lock).fails + 1;
  const wait = lockDelay(fails);
  return { fails, until: wait ? now + wait : 0 };
}

/* ---------- Keys ---------- */
async function kekFromPassword(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, AES, false, ['wrapKey', 'unwrapKey']);
}
async function kekFromSecret(secret, salt) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(BIO_INFO) }, base, AES, false, ['wrapKey', 'unwrapKey']);
}
async function wrap(key, kek) {
  const iv = random(12);
  const data = await crypto.subtle.wrapKey('raw', key, kek, { name: 'AES-GCM', iv });
  return { iv: toB64(iv), data: toB64(data) };
}
async function unwrap(box, kek, extractable) {
  try {
    return await crypto.subtle.unwrapKey('raw', fromB64(box.data), kek, { name: 'AES-GCM', iv: fromB64(box.iv) }, AES, extractable, ['encrypt', 'decrypt']);
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError('wrong-password');
  }
}
async function seal(key, value, aad) {
  const iv = random(12);
  const params = { name: 'AES-GCM', iv, ...(aad ? { additionalData: te.encode(aad) } : {}) };
  const data = await crypto.subtle.encrypt(params, key, te.encode(JSON.stringify(value)));
  return { iv: toB64(iv), data: toB64(data) };
}
async function unseal(key, box, aad) {
  const params = { name: 'AES-GCM', iv: fromB64(box.iv), ...(aad ? { additionalData: te.encode(aad) } : {}) };
  let plain;
  try { plain = await crypto.subtle.decrypt(params, key, fromB64(box.data)); } catch { throw new VaultError('wrong-password'); }
  try { return JSON.parse(td.decode(plain)); } catch { throw new VaultError('corrupt'); }
}
async function confirmCheck(key, entry) {
  let text;
  try { text = await unseal(key, entry.check); } catch { throw new VaultError('wrong-password'); }
  if (text !== CHECK_TEXT) throw new VaultError('wrong-password');
}

// A new vault entry for this password. The returned key is not extractable.
export async function createVault(password, { iter = VAULT_ITER } = {}) {
  if (checkSecretPassword(password)) throw new VaultError('weak-password');
  const salt = random(16);
  const kek = await kekFromPassword(password, salt, iter);
  const fresh = await crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
  const wrapped = await wrap(fresh, kek);
  // Round trip: the key kept from now on is the one unwrapped from what will be saved.
  const key = await unwrap(wrapped, kek, false);
  const check = await seal(key, CHECK_TEXT);
  const entry = { kid: newKid(), v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter, salt: toB64(salt) }, wrap: wrapped, check, createdAt: Date.now() };
  await confirmCheck(key, entry);
  return { entry, key };
}

// The note key for this entry, or VaultError('wrong-password').
// extractable is only for setting up biometric unlock, where the key must be wrapped once more.
export async function unlockEntry(entry, password, { extractable = false } = {}) {
  if (!validEntry(entry)) throw new VaultError('corrupt');
  if (typeof password !== 'string' || !password) throw new VaultError('wrong-password');
  const kek = await kekFromPassword(password, fromB64(entry.kdf.salt), entry.kdf.iter);
  const key = await unwrap(entry.wrap, kek, extractable);
  await confirmCheck(key, entry);
  return key;
}

/* ---------- Notes ---------- */
const content = n => ({
  type: n.type === 'list' ? 'list' : 'text',
  title: String(n.title ?? ''),
  body: String(n.body ?? ''),
  items: (Array.isArray(n.items) ? n.items : []).map(i => ({ id: String(i.id), text: String(i.text ?? ''), done: !!i.done })),
});
// Encrypts a note's content. The note id is bound in, so a sealed text cannot be moved to another note.
// Decrypts the result again and compares before returning: nothing is written unless this passes.
export async function sealNote(key, kid, note) {
  if (!key || typeof kid !== 'string' || typeof note?.id !== 'string') throw new VaultError('locked');
  const plain = content(note);
  const box = await seal(key, plain, note.id);
  const enc = { v: 1, kid, iv: box.iv, data: box.data };
  let back;
  try { back = await openNote(key, enc, note.id); } catch { throw new VaultError('mismatch'); }
  if (JSON.stringify(back) !== JSON.stringify(plain)) throw new VaultError('mismatch');
  return enc;
}
export async function openNote(key, enc, id) {
  const v = await unseal(key, enc, id);
  if (!v || typeof v !== 'object' || !Array.isArray(v.items)) throw new VaultError('corrupt');
  return content(v);
}

/* ---------- Biometric (WebAuthn PRF) ---------- */
// secret: the 32 bytes the authenticator returns for our PRF salt, only after the user verified.
export async function wrapWithSecret(extractableKey, secret, entry) {
  const salt = random(16);
  const kek = await kekFromSecret(secret, salt);
  const box = await wrap(extractableKey, kek);
  const key = await unwrap(box, kek, false);
  await confirmCheck(key, entry);
  return { salt: toB64(salt), ...box };
}
export async function unwrapWithSecret(bio, secret, entry) {
  const kek = await kekFromSecret(secret, fromB64(bio.salt));
  const key = await unwrap(bio, kek, false);
  await confirmCheck(key, entry);
  return key;
}

/* ---------- Stored shapes ---------- */
const isStr = (s, max = 4096) => typeof s === 'string' && s.length > 0 && s.length <= max;
const validBox = b => !!b && isStr(b.iv, 64) && isStr(b.data, 8192);
export function validEntry(e) {
  const k = e?.kdf;
  return !!e && isStr(e.kid, 64) && !!k && k.name === 'PBKDF2' && k.hash === 'SHA-256'
    && Number.isInteger(k.iter) && k.iter >= 100000 && k.iter <= 10000000 && isStr(k.salt, 64)
    && validBox(e.wrap) && validBox(e.check);
}
const cleanEntry = e => ({
  kid: e.kid, v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: e.kdf.iter, salt: e.kdf.salt },
  wrap: { iv: e.wrap.iv, data: e.wrap.data }, check: { iv: e.check.iv, data: e.check.data },
  createdAt: Number.isFinite(e.createdAt) ? e.createdAt : 0,
});
// The encrypted part of a stored hidden note, or null.
export function cleanEnc(e) {
  if (!e || typeof e !== 'object' || !isStr(e.kid, 64) || !isStr(e.iv, 64) || !isStr(e.data, 4000000)) return null;
  return { v: 1, kid: e.kid, iv: e.iv, data: e.data };
}
// { current, keys: { kid: entry }, bio } as kept in IndexedDB (meta store, id "vault").
export function sanitizeVault(raw, { keepBio = true } = {}) {
  if (!raw || typeof raw !== 'object' || !raw.keys || typeof raw.keys !== 'object') return null;
  const keys = {};
  Object.entries(raw.keys).forEach(([kid, e]) => { if (validEntry(e) && e.kid === kid) keys[kid] = cleanEntry(e); });
  if (!Object.keys(keys).length) return null;
  const current = typeof raw.current === 'string' && keys[raw.current] ? raw.current : null;
  const b = raw.bio;
  const bio = keepBio && b && b.kid === current && isStr(b.credId, 2048) && isStr(b.prf, 128) && isStr(b.salt, 64) && validBox(b) ? { kid: b.kid, credId: b.credId, prf: b.prf, salt: b.salt, iv: b.iv, data: b.data } : null;
  return { id: 'vault', current, keys, bio };
}
// What a backup carries: every key entry (salt, wrapped key, check block). Never the biometric part,
// which only works on the device that made it.
export const exportVault = v => (v ? { current: v.current, keys: v.keys } : null);
// Joins this device's vault with one from a backup. This device's current key stays current,
// unless the backup replaces everything. Keys no note uses any more are dropped (the current stays).
export function mergeVault(local, incoming, usedKids, { replace = false } = {}) {
  const keys = { ...(incoming?.keys ?? {}), ...(local?.keys ?? {}) };
  let current = replace ? (incoming?.current ?? local?.current ?? null) : (local?.current ?? incoming?.current ?? null);
  if (current && !keys[current]) current = null;
  Object.keys(keys).forEach(k => { if (k !== current && !usedKids.has(k)) delete keys[k]; });
  if (!Object.keys(keys).length) return null;
  const bio = local?.bio && local.bio.kid === current ? local.bio : null;
  return { id: 'vault', current, keys, bio };
}
