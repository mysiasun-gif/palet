// Palet: colour notes, checklists and reminders. Data stays on the device (IndexedDB),
// with an optional encrypted backup in the user's own Google Drive (cloud.js).
import { CloudError, checkPassword, encryptBackup, decryptBackup, createDrive, createAuth, loadGis, gisReady } from './cloud.js';
import {
  VaultError, createVault, unlockEntry, sealNote, openNote as unsealNote, wrapWithSecret, unwrapWithSecret, checkSecretPassword,
  passwordStrength, lockRemaining, failedTry, cleanEnc, sanitizeVault, exportVault, mergeVault, toB64, fromB64,
} from './vault.js';

const $ = (s, r = document) => r.querySelector(s);

const COLORS = [
  { id: 'red', name: 'Kırmızı' },
  { id: 'orange', name: 'Turuncu' },
  { id: 'yellow', name: 'Sarı' },
  { id: 'green', name: 'Yeşil' },
  { id: 'blue', name: 'Mavi' },
  { id: 'purple', name: 'Mor' },
  { id: 'pink', name: 'Pembe' },
  { id: 'gray', name: 'Gri' },
  { id: 'white', name: 'Beyaz' },
];
const COLOR_IDS = COLORS.map(c => c.id);
const colorName = id => COLORS.find(c => c.id === id)?.name ?? '';
const VIEWS = { notes: 'Notlar', calendar: 'Takvim', archive: 'Arşiv', trash: 'Çöp kutusu' };
const SORTS = {
  updated: 'Son düzenlenen',
  created: 'Son oluşturulan',
  title: 'Başlığa göre (A–Z)',
  color: 'Renge göre',
  reminder: 'Hatırlatıcı tarihine göre',
  manual: 'Elle (sürükle)',
};
const KINDS = { all: 'Hepsi', text: 'Notlar', list: 'Listeler', reminder: 'Hatırlatıcılı', secret: 'Gizli' };
const TAPES = ['#F4A6BD', '#F6B26B', '#8FD9C0', '#BBA7EE', '#F3D46B'];
const THEMES = { system: 'Sistem ayarı', light: 'Açık', dark: 'Koyu' };
const TRASH_DAYS = 30;
const DAY = 86400000;

/* ---------- Preferences (per device convenience) ---------- */
const PREF_KEY = 'palet.prefs';
const DEFAULT_PREFS = { layout: 'grid', sort: 'updated', theme: 'system', lastColor: 'yellow', secretAfter: 0 };
// Cloud settings kept on the device. Never the token or the password: those live only in memory.
const DEFAULT_CLOUD = { connected: false, email: '', setup: false, encrypt: true, auto: false, lastBackupAt: 0, lastHash: '' };
// Read before anything is saved: settings from an earlier visit mean this is not a first run.
const HAD_PREFS = (() => { try { return localStorage.getItem(PREF_KEY) !== null; } catch { return false; } })();
function loadPrefs() {
  let p;
  try { p = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; }
  catch { p = { ...DEFAULT_PREFS }; }
  p.cloud = { ...DEFAULT_CLOUD, ...(p.cloud && typeof p.cloud === 'object' ? p.cloud : {}) };
  return p;
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs)); } catch { /* storage unavailable */ }
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'palet';
const STORE = 'notes';
const META = 'meta';   // version 2: the hidden-note vault record lives here; notes are untouched
let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}
// One transaction. If fn throws, the transaction is aborted, so nothing it started is kept.
async function tx(mode, fn, stores = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let req;
    try {
      req = Array.isArray(stores) ? fn(...stores.map(s => t.objectStore(s))) : fn(t.objectStore(stores));
    } catch (err) {
      try { t.abort(); } catch { /* already finished */ }
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new DOMException('aborted', 'AbortError'));
  });
}
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = note => tx('readwrite', s => s.put(note));
const dbDelete = id => tx('readwrite', s => s.delete(id));
const dbPutMany = notes => tx('readwrite', s => { notes.forEach(n => s.put(n)); });
const dbGetVault = () => tx('readonly', s => s.get('vault'), META);
// Notes and the vault record in one transaction: all of it is written, or none of it.
// vault: an object to save, null to remove it, undefined to leave it as it is.
// replace: the notes store becomes exactly these notes.
const dbWrite = (notes, vault, { replace = false, removeIds = [] } = {}) => tx('readwrite', (ns, ms) => {
  if (replace) ns.clear();
  removeIds.forEach(id => ns.delete(id));
  notes.forEach(n => ns.put(n));
  if (vault) ms.put(vault); else if (vault === null) ms.delete('vault');
}, [STORE, META]);

let persistAsked = false;
function requestPersist() {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}

/* ---------- Model ---------- */
const uid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

function createNote(extra = {}) {
  const t = Date.now();
  return {
    id: uid(), type: 'text', title: '', body: '', items: [],
    color: 'yellow', pinned: false, archived: false, deletedAt: null,
    reminderAt: null, reminderFired: false, createdAt: t, updatedAt: t, ...extra,
  };
}
const isHidden = n => !!n?.enc;
const isEmpty = n => !n.enc && !n.title.trim() && !n.body.trim() && !n.items.some(i => i.text.trim());

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const num = v => (Number.isFinite(v) ? v : null);
  const t = Date.now();
  const enc = cleanEnc(raw.enc);
  return {
    id: raw.id.slice(0, 80),
    type: raw.type === 'list' ? 'list' : 'text',
    title: String(raw.title ?? '').slice(0, 2000),
    body: String(raw.body ?? '').slice(0, 200000),
    items: Array.isArray(raw.items)
      ? raw.items.filter(i => i && typeof i === 'object').map(i => ({ id: String(i.id ?? uid()), text: String(i.text ?? ''), done: !!i.done }))
      : [],
    color: COLOR_IDS.includes(raw.color) ? raw.color : 'yellow',
    pinned: !!raw.pinned,
    archived: !!raw.archived,
    deletedAt: num(raw.deletedAt),
    reminderAt: num(raw.reminderAt),
    reminderFired: !!raw.reminderFired,
    createdAt: num(raw.createdAt) ?? t,
    updatedAt: num(raw.updatedAt) ?? t,
    // Optional manual position; notes saved before it existed simply have none.
    ...(Number.isFinite(raw.order) ? { order: raw.order } : {}),
    // A hidden note: content only in enc; the plain fields stay empty.
    ...(enc ? { type: 'text', title: '', body: '', items: [], enc } : {}),
  };
}
// A position above every manually ordered note, so a new note lands on top.
function topOrder() {
  const orders = state.notes.map(n => n.order).filter(Number.isFinite);
  if (orders.length) return Math.min(...orders) - 1;
  return state.prefs.sort === 'manual' ? 0 : undefined;
}

const state = {
  notes: [],
  pending: null,          // a new note that has not been saved yet
  view: 'notes',
  filterColor: null,
  kind: 'all',
  query: '',
  editing: null,
  openedFromApp: false,
  openSecret: null,       // the unlocked copy of a hidden note about to open in the editor
  doneOpen: true,
  calMonth: startOfMonth(new Date()),
  calDay: dayKey(Date.now()),
  prefs: loadPrefs(),
};
const findNote = id => state.notes.find(n => n.id === id) ?? (state.pending?.id === id ? state.pending : null);

async function saveNote(n, { touch = true } = {}) {
  if (touch) n.updatedAt = Date.now();
  let rec = n;
  if (n.secret) {
    // An open hidden note: only its sealed form is kept in the list and written to disk.
    try { rec = await sealedRecord(n); } catch (err) {
      console.error(err?.name ?? 'seal');
      toast('Gizli not kaydedilemedi. Notu kapatmadan bir daha dene.');
      return;
    }
  }
  const i = state.notes.findIndex(x => x.id === rec.id);
  if (i < 0) state.notes.push(rec); else state.notes[i] = rec;
  if (state.pending?.id === n.id) state.pending = null;
  try { await dbPut(rec); } catch (err) { console.error(err?.name ?? 'save'); toast('Not kaydedilemedi. Depolama alanını kontrol edip tekrar dene.'); }
  requestPersist();
  scheduleAutoBackup();
}
async function destroyNote(id) {
  state.notes = state.notes.filter(n => n.id !== id);
  await dbDelete(id);
  scheduleAutoBackup();
}

/* ---------- Helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const lower = s => s.toLocaleLowerCase('tr');

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function keyToDate(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

const fmtTime = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });
const fmtDayYear = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' });
const fmtLongDay = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });

function whenLabel(ts, withTime = true) {
  const d = new Date(ts);
  const now = new Date();
  const k = dayKey(d);
  const t = withTime ? ` ${fmtTime.format(d)}` : '';
  if (k === dayKey(now)) return `Bugün${t}`;
  if (k === dayKey(addDays(now, 1))) return `Yarın${t}`;
  if (k === dayKey(addDays(now, -1))) return `Dün${t}`;
  return `${(d.getFullYear() === now.getFullYear() ? fmtDay : fmtDayYear).format(d)}${t}`;
}
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function noteText(n) {
  return n.type === 'list' ? n.items.map(i => `${i.done ? '[x]' : '[ ]'} ${i.text}`).join('\n') : n.body;
}
function noteLabel(n) {
  if (isHidden(n)) return 'Gizli not';
  const first = (n.title || (n.type === 'list' ? n.items[0]?.text : n.body.split('\n')[0]) || '').trim();
  return first ? first.slice(0, 60) : 'Başlıksız not';
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  $('#toast-msg').textContent = msg;
  const btn = $('#toast-act');
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.run(); };
  }
  el.classList.toggle('in-editor', !$('#editor').hidden);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 3500);
}
function hideToast() { $('#toast').hidden = true; }

/* ---------- Dialog helpers ---------- */
// items: { icon, label, sub?, dot?, danger?, disabled?, checked? (radio), toggle? (switch), keep? (stay open), run }
function showSheet(title, items, { brand = false, info = '', onClose } = {}) {
  const dlg = $('#dlg-sheet');
  $('#sheet-brand').hidden = !brand;
  $('#sheet-title').textContent = title;
  const infoEl = $('#sheet-info');
  infoEl.hidden = !info;
  infoEl.innerHTML = info;
  const box = $('#sheet-items');
  box.innerHTML = '';
  items.filter(Boolean).forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sheet-item${it.danger ? ' danger' : ''}${it.sub ? ' has-sub' : ''}`;
    const label = it.sub
      ? `<span class="sheet-label"><span>${esc(it.label)}</span><span class="sheet-sub${it.dot ? ' pending' : ''}">${esc(it.sub)}</span></span>`
      : `<span>${esc(it.label)}</span>`;
    const end = it.toggle !== undefined ? '<span class="switch" aria-hidden="true"></span>' : it.checked ? icon('check', 'tick') : '';
    b.innerHTML = `${icon(it.icon)}${label}${end}`;
    if (it.checked !== undefined) { b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(!!it.checked)); }
    if (it.toggle !== undefined) { b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!it.toggle)); }
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', () => { if (!it.keep) dlg.close(); it.run(b); });
    box.appendChild(b);
  });
  if (onClose) {
    // The previous sheet's close event can arrive after this one opened; only a real close counts.
    const h = () => { if (dlg.open) return; dlg.removeEventListener('close', h); onClose(); };
    dlg.addEventListener('close', h);
  }
  if (!dlg.open) dlg.showModal();
  box.querySelector('button')?.focus();
}
// A tap on the dimmed area around a sheet closes it.
$('#dlg-sheet').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function confirmDialog({ title, body, ok }) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

/* ---------- Routing ---------- */
function parseRoute() {
  const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 'note' && b) return { note: decodeURIComponent(b) };
  return { view: VIEWS[a] ? a : 'notes' };
}
function onRoute() {
  const r = parseRoute();
  if (r.note) {
    if (state.editing?.id !== r.note) openEditor(r.note);
    return;
  }
  if (state.editing) closeEditor();
  if (r.view !== state.view) {
    state.view = r.view;
    state.filterColor = null;
    state.kind = 'all';
    window.scrollTo(0, 0);
  }
  render();
}
function goView(v) { location.replace(`#/${v}`); }
function openNote(id) {
  state.openedFromApp = true;
  location.hash = `#/note/${encodeURIComponent(id)}`;
}
function leaveEditor() {
  if (state.openedFromApp) history.back();
  else location.replace(`#/${state.view}`);
}

/* ---------- List views ---------- */
function scopeNotes(view) {
  return state.notes.filter(n =>
    view === 'trash' ? !!n.deletedAt
      : view === 'archive' ? n.archived && !n.deletedAt
        : !n.archived && !n.deletedAt);
}
function matches(n, q) {
  if (!q) return true;
  return lower(`${n.title}\n${n.body}\n${n.items.map(i => i.text).join('\n')}`).includes(q);
}
function sortNotes(list) {
  const s = state.prefs.sort;
  const cmp = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => noteLabel(a).localeCompare(noteLabel(b), 'tr'),
    color: (a, b) => COLOR_IDS.indexOf(a.color) - COLOR_IDS.indexOf(b.color) || b.updatedAt - a.updatedAt,
    reminder: (a, b) => (a.reminderAt ?? Infinity) - (b.reminderAt ?? Infinity) || b.updatedAt - a.updatedAt,
    manual: (a, b) => {
      const ao = Number.isFinite(a.order); const bo = Number.isFinite(b.order);
      if (ao && bo && a.order !== b.order) return a.order - b.order;
      if (ao !== bo) return ao ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    },
  }[s] ?? ((a, b) => b.updatedAt - a.updatedAt);
  return list.sort(cmp);
}

// Stable per-note "randomness" so a note keeps its tilt and tape between renders.
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function matchesKind(n) {
  const k = state.kind;
  if (k === 'secret') return isHidden(n);
  if (k === 'reminder') return !!n.reminderAt;
  return k === 'all' || (n.type === k && !isHidden(n));
}

function cardHtml(n) {
  let preview = '';
  const hidden = isHidden(n);
  if (hidden) {
    preview = `<p class="card-secret">${icon('lock')}<span>Gizli not</span></p>`;
  } else if (n.type === 'list') {
    const open = n.items.filter(i => !i.done && i.text.trim());
    const done = n.items.filter(i => i.done && i.text.trim());
    const shown = open.slice(0, 5);
    const extraOpen = open.length - shown.length;
    preview = `<ul class="card-list">${shown.map(i => `<li><span class="box"></span><span>${esc(i.text)}</span></li>`).join('')}</ul>`;
    const bits = [];
    if (extraOpen > 0) bits.push(`${extraOpen} madde daha`);
    if (done.length) bits.push(`${done.length} tamamlandı`);
    if (bits.length) preview += `<p class="card-more">${bits.join(', ')}</p>`;
  } else if (n.body.trim()) {
    preview = `<p class="card-body">${esc(n.body.slice(0, 400))}</p>`;
  }
  const meta = [];
  if (n.reminderAt && !n.deletedAt) {
    const past = n.reminderAt < Date.now();
    meta.push(`<span class="card-when${past ? ' past' : ''}">${icon('bell')}${esc(whenLabel(n.reminderAt))}</span>`);
  }
  if (n.deletedAt) {
    const left = Math.max(0, Math.ceil((n.deletedAt + TRASH_DAYS * DAY - Date.now()) / DAY));
    meta.push(`<span class="card-when">${left} gün sonra silinecek</span>`);
  }
  const showPin = n.pinned && !n.deletedAt;
  // What holds the note up says what kind it is: a pushpin for pinned notes,
  // a paper clip for lists, a strip of tape for everything else.
  const h = hashStr(n.id);
  const tilt = ((h % 61) / 10 - 3).toFixed(1);
  const hold = showPin ? 'pin' : n.type === 'list' ? 'clip' : 'tape';
  const curl = (h >>> 8) % 3 === 0 ? ' curl' : '';
  const holder = hold === 'pin' ? '<svg class="holder pin" aria-hidden="true"><use href="#d-pushpin"/></svg>'
    : hold === 'clip' ? '<svg class="holder clip" aria-hidden="true"><use href="#d-clip"/></svg>'
      : `<span class="holder tape" aria-hidden="true" style="--tape:${TAPES[(h >>> 4) % TAPES.length]};--tape-tilt:${((h >>> 12) % 9) - 4}deg"></span>`;
  return `<article class="card${curl}${hidden ? ' secret' : ''}" data-id="${esc(n.id)}" data-hold="${hold}" style="--c:var(--n-${n.color});--tilt:${tilt}deg">
    <button class="card-hit" type="button" data-open="${esc(n.id)}" aria-label="${hidden ? `Gizli not, ${colorName(n.color)}${n.pinned ? ', sabitlenmiş' : ''}, açmak için şifre gerekir` : `${esc(noteLabel(n))}, ${colorName(n.color)} not${n.pinned ? ', sabitlenmiş' : ''}${n.type === 'list' ? ', liste' : ''}`}"></button>
    ${holder}
    ${!hidden && n.title.trim() ? `<h3 class="card-title">${esc(n.title)}</h3>` : ''}
    ${preview || (n.title.trim() ? '' : '<p class="card-body">Boş not</p>')}
    ${meta.length ? `<div class="card-meta">${meta.join('')}</div>` : ''}
  </article>`;
}
const notesBlock = list => `<div class="notes ${state.prefs.layout === 'rows' ? 'rows' : 'grid'}">${list.map(cardHtml).join('')}</div>`;

function emptyArt(colors) {
  return `<div class="empty-art" aria-hidden="true">${colors.map((c, i) => `<span style="--c:var(--n-${c});--i:${i - (colors.length - 1) / 2}"></span>`).join('')}</div>`;
}
function emptyHtml(scoped) {
  const v = state.view;
  if (state.query) {
    return `<div class="empty">${emptyArt(['gray'])}<h2>Sonuç yok</h2><p>“${esc(state.query)}” hiçbir notta geçmiyor${v === 'notes' ? '' : ` (${VIEWS[v].toLocaleLowerCase('tr')})`}. Arşivi ya da çöp kutusunu da kontrol edebilirsin.</p><button class="btn outline" type="button" data-act="clear-search">Aramayı temizle</button></div>`;
  }
  if (state.kind === 'list' && !state.filterColor && v === 'notes') {
    return `<div class="empty">${emptyArt(['green'])}<h2>Henüz liste yok</h2><p>+ düğmesine dokun, boş bir liste açılsın. Yazdığın bir notu da editördeki Liste düğmesiyle listeye çevirebilirsin.</p><div class="empty-actions"><button class="btn primary" type="button" data-act="new">${icon('plus')}Liste ekle</button>${scoped.length ? '<button class="btn outline" type="button" data-act="clear-kind">Hepsini göster</button>' : ''}</div></div>`;
  }
  if (state.kind !== 'all' && scoped.length && !state.filterColor) {
    return `<div class="empty">${emptyArt(['green'])}<h2>Burada ${KINDS[state.kind].toLocaleLowerCase('tr')} not yok</h2><p>${state.kind === 'reminder' ? 'Bir notta zil simgesine dokunarak hatırlatıcı kurabilirsin.' : state.kind === 'secret' ? 'Bir notu gizlemek için notu aç, ⋮ menüsünden “Gizli yap”ı seç.' : state.kind === 'list' ? 'Bu bölümde liste yok.' : 'Bu bölümdeki notların hepsi liste.'}</p><button class="btn outline" type="button" data-act="clear-kind">Hepsini göster</button></div>`;
  }
  if (state.filterColor && scoped.length) {
    return `<div class="empty">${emptyArt([state.filterColor])}<h2>${colorName(state.filterColor)} not yok</h2><p>Bu bölümde bu renkte not bulunmuyor.</p><button class="btn outline" type="button" data-act="clear-filter">Tüm renkleri göster</button></div>`;
  }
  if (v === 'archive') {
    return `<div class="empty">${emptyArt(['gray', 'blue'])}<h2>Arşiv boş</h2><p>Bir notu arşivlersen ana listeden kalkar ama burada saklanır.</p></div>`;
  }
  if (v === 'trash') {
    return `<div class="empty">${emptyArt(['gray'])}<h2>Çöp kutusu boş</h2><p>Sildiğin notlar ${TRASH_DAYS} gün burada kalır, sonra kendiliğinden silinir.</p></div>`;
  }
  return `<div class="empty">${emptyArt(['yellow', 'blue', 'red'])}<h2>İlk notunu yaz</h2><p>Notlarına renk vererek onları gruplayabilir, yapılacaklar listesi tutabilir, hatırlatıcı kurabilirsin.</p><button class="btn primary" type="button" data-act="new">${icon('plus')}Not ekle</button></div>`;
}

function renderPalette() {
  const el = $('#palette');
  const kinds = $('#kinds');
  const isCal = state.view === 'calendar';
  el.hidden = kinds.hidden = isCal;
  if (isCal) return;
  const scoped = scopeNotes(state.view);
  // The "Gizli" tab appears once there is a hidden note.
  const showSecret = state.kind === 'secret' || state.notes.some(isHidden);
  kinds.innerHTML = Object.entries(KINDS).filter(([k]) => k !== 'secret' || showSecret).map(([k, label]) =>
    `<button class="kind" type="button" data-kind="${k}" aria-pressed="${state.kind === k}">${label}</button>`).join('');
  const counts = Object.fromEntries(COLOR_IDS.map(c => [c, 0]));
  scoped.forEach(n => { counts[n.color]++; });
  el.classList.toggle('filtering', !!state.filterColor);
  el.innerHTML = COLORS.map(c => {
    const n = counts[c.id];
    return `<button class="seg${n ? '' : ' none'}" type="button" style="--c:var(--n-${c.id})" data-color="${c.id}" aria-pressed="${state.filterColor === c.id}" aria-label="${c.name}: ${n} not">${n ? `<span aria-hidden="true">${n}</span>` : ''}</button>`;
  }).join('');
}

function renderList(main) {
  const scoped = scopeNotes(state.view);
  const q = lower(state.query.trim());
  const list = sortNotes(scoped.filter(n => (!state.filterColor || n.color === state.filterColor) && matchesKind(n) && matches(n, q)));
  let html = '';
  if (state.filterColor) {
    html += `<div class="filter-note"><span class="dot" style="--c:var(--n-${state.filterColor})"></span><span>Yalnızca ${colorName(state.filterColor).toLocaleLowerCase('tr')} notlar</span><button class="link-btn" type="button" data-act="clear-filter">Tümünü göster</button></div>`;
  }
  if (state.view === 'trash' && scoped.length) {
    html += `<div class="banner"><p>Çöp kutusundaki notlar ${TRASH_DAYS} gün sonra kalıcı olarak silinir.</p><button class="btn ghost danger-text" type="button" data-act="empty-trash">Çöpü boşalt</button></div>`;
  }
  if (!list.length) {
    html += emptyHtml(scoped);
  } else if (state.view !== 'trash' && list.some(n => n.pinned) && list.some(n => !n.pinned)) {
    html += `<h2 class="section-head">Sabitlenenler</h2>${notesBlock(list.filter(n => n.pinned))}`;
    html += `<h2 class="section-head">Diğerleri</h2>${notesBlock(list.filter(n => !n.pinned))}`;
  } else {
    const ordered = state.view === 'trash' ? list : [...list.filter(n => n.pinned), ...list.filter(n => !n.pinned)];
    html += notesBlock(ordered);
  }
  main.innerHTML = html;
}

/* ---------- Calendar ---------- */
function renderCalendar(main) {
  const m = state.calMonth;
  const y = m.getFullYear();
  const mo = m.getMonth();
  const offset = (new Date(y, mo, 1).getDay() + 6) % 7; // Monday first
  const days = new Date(y, mo + 1, 0).getDate();
  const today = dayKey(Date.now());

  const byDay = new Map();
  const add = (k, n) => { if (!byDay.has(k)) byDay.set(k, new Map()); byDay.get(k).set(n.id, n); };
  state.notes.filter(n => !n.deletedAt).forEach(n => {
    add(dayKey(n.createdAt), n);
    if (n.reminderAt) add(dayKey(n.reminderAt), n);
  });

  let cells = '';
  ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].forEach(w => { cells += `<div class="cal-wd" aria-hidden="true">${w}</div>`; });
  for (let i = 0; i < offset; i++) cells += '<div class="cal-day out"></div>';
  for (let d = 1; d <= days; d++) {
    const k = dayKey(new Date(y, mo, d));
    const notes = [...(byDay.get(k)?.values() ?? [])];
    const dots = notes.slice(0, 6).map(n => `<i style="--c:var(--n-${n.color})"></i>`).join('');
    const label = `${fmtLongDay.format(new Date(y, mo, d))}${notes.length ? `, ${notes.length} not` : ''}`;
    cells += `<button class="cal-day${k === today ? ' today' : ''}" type="button" data-day="${k}" aria-pressed="${k === state.calDay}" aria-label="${esc(label)}"><span class="num">${d}</span><span class="dots">${dots}</span></button>`;
  }

  const sel = state.calDay;
  const reminders = sortByTime(state.notes.filter(n => !n.deletedAt && n.reminderAt && dayKey(n.reminderAt) === sel), 'reminderAt');
  const written = sortByTime(state.notes.filter(n => !n.deletedAt && dayKey(n.createdAt) === sel), 'createdAt');
  let list = `<h3>${esc(fmtLongDay.format(keyToDate(sel)))}</h3>`;
  if (!reminders.length && !written.length) {
    list += `<p class="cal-empty">Bu günde hatırlatıcı ya da yazılmış not yok.</p><button class="btn outline" type="button" data-act="new">${icon('plus')}Bu güne not ekle</button>`;
  } else {
    if (reminders.length) list += `<h2 class="section-head">Hatırlatıcılar</h2><div class="notes rows">${reminders.map(cardHtml).join('')}</div>`;
    if (written.length) list += `<h2 class="section-head">Bu gün yazılanlar</h2><div class="notes rows">${written.map(cardHtml).join('')}</div>`;
  }

  main.innerHTML = `<div class="cal">
    <div class="cal-head">
      <h2 class="cal-month">${esc(fmtMonth.format(m))}</h2>
      <button class="btn ghost" type="button" data-act="cal-today">Bugün</button>
      <button class="icon-btn" type="button" data-act="cal-prev" aria-label="Önceki ay">${icon('chev-left')}</button>
      <button class="icon-btn" type="button" data-act="cal-next" aria-label="Sonraki ay">${icon('chev-right')}</button>
    </div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-list">${list}</div>
  </div>`;
}
const sortByTime = (list, key) => list.sort((a, b) => a[key] - b[key]);

/* ---------- Render ---------- */
function render() {
  // Never rebuild the board under a note the user is holding; catch up on drop.
  if (drag) { drag.renderPending = true; return; }
  $('#view-title').textContent = VIEWS[state.view];
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  const isCal = state.view === 'calendar';
  $('#search-row').hidden = isCal;
  $('#fab').hidden = state.view === 'trash' || state.view === 'archive';
  $('#fab').setAttribute('aria-label', state.view === 'notes' && state.kind === 'list' ? 'Yeni liste' : 'Yeni not');
  renderPalette();
  const main = $('#view');
  if (isCal) renderCalendar(main); else renderList(main);
}

/* ---------- Editor ---------- */
const ed = {
  root: $('#editor'), title: $('#ed-title'), body: $('#ed-body'), list: $('#ed-list'),
  chip: $('#ed-chip'), stamp: $('#ed-stamp'), colors: $('#ed-colors'),
  pin: $('#ed-pin'), archive: $('#ed-archive'), type: $('#ed-type'),
};
let saveTimer = null;

function newNote() {
  const extra = { color: state.filterColor ?? state.prefs.lastColor ?? 'yellow' };
  const order = topOrder();
  if (order !== undefined) extra.order = order;
  // With the "Listeler" filter on, + starts a checklist with one empty item.
  if (state.view === 'notes' && state.kind === 'list') {
    extra.type = 'list';
    extra.items = [{ id: uid(), text: '', done: false }];
  }
  if (state.view === 'calendar' && state.calDay !== dayKey(Date.now())) {
    const d = keyToDate(state.calDay);
    d.setHours(9, 0, 0, 0);
    if (d.getTime() > Date.now()) extra.reminderAt = d.getTime();
  }
  state.pending = createNote(extra);
  openNote(state.pending.id);
}

function openEditor(id) {
  if (state.editing && saveTimer) commit(); // flush the note being switched away from
  let n = findNote(id);
  if (isHidden(n)) {
    // A hidden note opens only from its unlocked copy; a link or reload asks for the password first.
    const open = state.openSecret?.id === id && sec.key ? state.openSecret : null;
    state.openSecret = null;
    if (!open) {
      location.replace(`#/${state.view}`);
      if (!n.deletedAt) setTimeout(() => openHidden(n), 0);
      return;
    }
    n = open;
  }
  if (!n || n.deletedAt) { location.replace(`#/${state.view}`); return; }
  state.editing = n;
  ed.title.value = n.title;
  ed.body.value = n.body;
  renderEditor();
  ed.root.hidden = false;
  ed.root.classList.remove('opening');
  void ed.root.offsetWidth;
  ed.root.classList.add('opening');
  document.body.style.overflow = 'hidden';
  hideToast();
  requestAnimationFrame(() => {
    autosize(ed.body);
    if (state.pending?.id === n.id) (n.type === 'list' ? ed.list.querySelector('.item-text') : ed.body)?.focus();
  });
}

function renderEditor() {
  const n = state.editing;
  ed.root.style.setProperty('--c', `var(--n-${n.color})`);
  ed.root.classList.toggle('secret', !!n.secret);
  syncStatusBar();
  ed.pin.setAttribute('aria-pressed', String(n.pinned));
  ed.pin.setAttribute('aria-label', n.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle');
  ed.pin.innerHTML = icon(n.pinned ? 'pin-fill' : 'pin');
  ed.archive.setAttribute('aria-label', n.archived ? 'Arşivden çıkar' : 'Arşivle');
  ed.archive.innerHTML = icon(n.archived ? 'unarchive' : 'archive');
  ed.type.setAttribute('aria-pressed', String(n.type === 'list'));
  ed.type.title = n.type === 'list' ? 'Düz metne dönüştür' : 'Yapılacaklar listesine dönüştür';
  if (n.reminderAt) {
    const past = n.reminderAt < Date.now();
    ed.chip.hidden = false;
    ed.chip.classList.toggle('past', past);
    ed.chip.innerHTML = `${icon('bell')}<span>${esc(whenLabel(n.reminderAt))}</span>`;
    ed.chip.setAttribute('aria-label', `Hatırlatıcı: ${whenLabel(n.reminderAt)}. Değiştirmek için dokun`);
  } else {
    ed.chip.hidden = true;
  }
  ed.body.hidden = n.type === 'list';
  ed.list.hidden = n.type !== 'list';
  if (n.type === 'list') renderItems();
  ed.colors.innerHTML = COLORS.map(c => `<button class="swatch" type="button" role="radio" style="--sc:var(--n-${c.id})" data-swatch="${c.id}" aria-checked="${n.color === c.id}" aria-label="${c.name}" tabindex="${n.color === c.id ? 0 : -1}">${icon('check')}</button>`).join('');
  updateStamp();
}

function updateStamp() {
  const n = state.editing;
  if (!n) return;
  const text = state.pending?.id === n.id ? 'Yeni not' : `Düzenlendi: ${whenLabel(n.updatedAt)}`;
  ed.stamp.innerHTML = n.secret ? `${icon('lock')}<span>Gizli not · ${esc(text)}</span>` : esc(text);
}

function renderItems() {
  const n = state.editing;
  const open = n.items.filter(i => !i.done);
  const done = n.items.filter(i => i.done);
  const row = i => `<li class="item${i.done ? ' done' : ''}" data-item="${esc(i.id)}">
      <button class="check" type="button" role="checkbox" aria-checked="${i.done}" aria-label="${i.done ? 'Tamamlanmadı olarak işaretle' : 'Tamamlandı olarak işaretle'}"><span>${i.done ? icon('check') : ''}</span></button>
      <textarea class="item-text" rows="1" aria-label="Liste maddesi" placeholder="Madde" enterkeyhint="next">${esc(i.text)}</textarea>
      <button class="item-del" type="button" aria-label="Maddeyi sil">${icon('close')}</button>
    </li>`;
  let html = `<ul class="items">${open.map(row).join('')}</ul>
    <button class="add-item" type="button" data-act="add-item">${icon('plus')}Madde ekle</button>`;
  if (done.length) {
    html += `<button class="done-head" type="button" data-act="toggle-done" aria-expanded="${state.doneOpen}">${icon('chev-right')}${done.length} tamamlanan madde</button>`;
    if (state.doneOpen) html += `<ul class="items">${done.map(row).join('')}</ul>`;
  }
  ed.list.innerHTML = html;
  ed.list.querySelectorAll('.item-text').forEach(autosize);
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(commit, 350);
}
async function commit() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const n = state.editing;
  if (!n) return;
  if (state.pending?.id === n.id && isEmpty(n)) return;
  await saveNote(n);
  updateStamp();
}

function closeEditor() {
  const n = state.editing;
  if (saveTimer || (n && state.pending?.id === n.id && !isEmpty(n))) commit();
  if (n && state.pending?.id === n.id && isEmpty(n)) state.pending = null;
  state.editing = null;
  state.openedFromApp = false;
  state.openSecret = null;
  if (n?.secret) {
    // Nothing of a hidden note stays in the page once it is closed.
    ed.title.value = ''; ed.body.value = ''; ed.list.innerHTML = ''; ed.stamp.textContent = '';
    ed.root.classList.remove('secret');
  }
  ed.root.hidden = true;
  document.body.style.overflow = '';
  syncStatusBar();
  scheduleReminders();
}

function addItemAfter(afterId, text = '') {
  const n = state.editing;
  const item = { id: uid(), text, done: false };
  const idx = afterId ? n.items.findIndex(i => i.id === afterId) : -1;
  if (idx < 0) {
    const firstDone = n.items.findIndex(i => i.done);
    n.items.splice(firstDone < 0 ? n.items.length : firstDone, 0, item);
  } else {
    n.items.splice(idx + 1, 0, item);
  }
  renderItems();
  focusItem(item.id);
  scheduleSave();
}
function focusItem(id, atEnd = true) {
  const el = ed.list.querySelector(`[data-item="${CSS.escape(id)}"] .item-text`);
  if (!el) return;
  el.focus();
  if (atEnd) el.setSelectionRange(el.value.length, el.value.length);
}

function convertType() {
  const n = state.editing;
  if (n.type === 'text') {
    const lines = n.body.split('\n').map(s => s.replace(/^\s*(?:[-*•]|\[[ xX]?\])\s*/, '').trim()).filter(Boolean);
    n.items = lines.map(text => ({ id: uid(), text, done: false }));
    if (!n.items.length) n.items.push({ id: uid(), text: '', done: false });
    n.body = '';
    n.type = 'list';
  } else {
    n.body = n.items.map(i => i.text).filter(t => t.trim()).join('\n');
    ed.body.value = n.body;
    n.items = [];
    n.type = 'text';
  }
  renderEditor();
  requestAnimationFrame(() => autosize(ed.body));
  scheduleSave();
}

async function moveToTrash(n, msg = 'Not çöp kutusuna taşındı') {
  const before = { deletedAt: n.deletedAt, pinned: n.pinned };
  n.deletedAt = Date.now();
  n.pinned = false;
  await saveNote(n, { touch: false });
  toast(msg, {
    label: 'Geri al',
    run: async () => { Object.assign(n, before); await saveNote(n, { touch: false }); render(); },
  });
}
async function setArchived(n, archived) {
  n.archived = archived;
  if (archived) n.pinned = false;
  await saveNote(n, { touch: false });
  toast(archived ? 'Not arşivlendi' : 'Not arşivden çıkarıldı', {
    label: 'Geri al',
    run: async () => { n.archived = !archived; await saveNote(n, { touch: false }); render(); },
  });
}

async function shareNote(n) {
  const text = [n.title.trim(), noteText(n).trim()].filter(Boolean).join('\n\n');
  if (!text) { toast('Paylaşılacak bir şey yok. Önce not yaz.'); return; }
  if (navigator.share) {
    try { await navigator.share({ title: n.title || undefined, text }); } catch { /* cancelled */ }
    return;
  }
  try { await navigator.clipboard.writeText(text); toast('Not panoya kopyalandı'); }
  catch { toast('Panoya kopyalanamadı. Metni seçip elle kopyala.'); }
}

function editorMenu() {
  const n = state.editing;
  showSheet(n.secret ? 'Gizli not' : 'Not', [
    { icon: n.type === 'text' ? 'checklist' : 'text', label: n.type === 'text' ? 'Yapılacaklar listesine dönüştür' : 'Düz metne dönüştür', run: convertType },
    { icon: 'share', label: 'Paylaş', run: () => shareNote(n) },
    {
      icon: 'copy', label: 'Kopyasını oluştur', run: async () => {
        if (isEmpty(n)) { toast('Boş not kopyalanamaz'); return; }
        await commit();
        const t = Date.now();
        const copy = { ...structuredClone(n), id: uid(), title: n.title ? `${n.title} (kopya)` : '', pinned: false, reminderAt: null, reminderFired: false, createdAt: t, updatedAt: t, items: n.items.map(i => ({ ...i, id: uid() })) };
        await saveNote(copy);
        if (copy.secret) state.openSecret = copy; // the copy of a hidden note is hidden too
        state.openedFromApp = true;
        location.replace(`#/note/${encodeURIComponent(copy.id)}`);
        toast('Kopya oluşturuldu');
      },
    },
    n.secret
      ? { icon: 'unlock', label: 'Gizliyi kaldır', run: () => unhideNote(n) }
      : { icon: 'lock', label: 'Gizli yap', sub: 'İçerik şifrelenir, listede kilitli görünür', run: () => makeHidden(n) },
    {
      icon: 'trash', label: 'Sil', danger: true, run: async () => {
        if (n.secret && !(await confirmSecret({ kid: sec.meta?.current, title: 'Gizli notu sil', text: 'Gizli not çöp kutusuna taşınacak. Onaylamak için gizli not şifreni gir.', action: 'Sil' }))) return;
        await commitOrDiscard(n);
        leaveEditor();
      },
    },
  ]);
}
async function commitOrDiscard(n) {
  clearTimeout(saveTimer); saveTimer = null;
  if (state.pending?.id === n.id) { state.pending = null; if (isEmpty(n)) { toast('Boş not silindi'); return; } }
  await moveToTrash(n);
}

/* ---------- Reminders ---------- */
const timers = new Map();
const MAX_DELAY = 2 ** 31 - 1;
function scheduleReminders() {
  timers.forEach(clearTimeout);
  timers.clear();
  const now = Date.now();
  state.notes.forEach(n => {
    if (!n.reminderAt || n.reminderFired || n.deletedAt) return;
    const delay = n.reminderAt - now;
    if (delay <= 0) fireReminder(n);
    else if (delay < MAX_DELAY) timers.set(n.id, setTimeout(() => fireReminder(n), delay));
  });
}
async function fireReminder(n) {
  n = state.notes.find(x => x.id === n.id) ?? n; // a hidden note's record is replaced on every save
  n.reminderFired = true;
  if (state.editing?.id === n.id) state.editing.reminderFired = true;
  await saveNote(n, { touch: false });
  // A hidden note's notification never shows its content.
  const title = noteLabel(n);
  const body = isHidden(n) ? '' : n.title ? noteText(n).slice(0, 140) : `Hatırlatıcı: ${whenLabel(n.reminderAt)}`;
  let shown = false;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) { await reg.showNotification(title, { body, tag: n.id, data: { id: n.id }, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' }); shown = true; }
      else { new Notification(title, { body, tag: n.id }); shown = true; }
    } catch { /* fall back to toast */ }
  }
  if (!shown || document.visibilityState === 'visible') {
    toast(`Hatırlatıcı: ${title}`, { label: 'Aç', run: () => openNote(n.id) });
  }
  if (!state.editing) render(); else if (state.editing.id === n.id) renderEditor();
}

function reminderHint() {
  if (!('Notification' in window)) return 'Bu tarayıcı bildirim göstermiyor. Hatırlatıcı, TakJot açıkken ekranda görünür.';
  if (Notification.permission === 'denied') return 'Bildirim izni kapalı. Hatırlatıcı, TakJot açıkken ekranda görünür. İzni tarayıcının site ayarlarından açabilirsin.';
  return 'Bildirim, TakJot açıkken gelir. Kapalıyken kaçan hatırlatıcılar uygulamayı açtığında gösterilir.';
}

function openReminderDialog() {
  const n = state.editing;
  const dlg = $('#dlg-remind');
  const input = $('#remind-at');
  const fallback = new Date(); fallback.setHours(fallback.getHours() + 1, 0, 0, 0);
  input.value = toLocalInput(n.reminderAt ?? fallback.getTime());
  input.min = toLocalInput(Date.now());
  $('#remind-remove').hidden = !n.reminderAt;
  $('#remind-hint').textContent = reminderHint();
  dlg.returnValue = '';
  dlg.showModal();
}
$('#dlg-remind').addEventListener('click', e => {
  const q = e.target.closest('[data-quick]')?.dataset.quick;
  if (!q) return;
  const d = new Date();
  if (q === 'tonight') { d.setHours(20, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); }
  if (q === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  if (q === 'week') { d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); }
  $('#remind-at').value = toLocalInput(d.getTime());
});
$('#remind-remove').addEventListener('click', () => $('#dlg-remind').close('remove'));
$('#remind-cancel').addEventListener('click', () => $('#dlg-remind').close('cancel'));
$('#dlg-remind').addEventListener('close', async () => {
  const n = state.editing;
  const v = $('#dlg-remind').returnValue;
  if (!n) return;
  if (v === 'remove') {
    n.reminderAt = null; n.reminderFired = false;
    toast('Hatırlatıcı kaldırıldı');
  } else if (v === 'save') {
    const ts = new Date($('#remind-at').value).getTime();
    if (!Number.isFinite(ts)) { toast('Tarih ve saat seç, sonra kaydet.'); return; }
    if (ts <= Date.now()) { toast('Geçmiş bir zaman seçildi. İleri bir tarih seç.'); return; }
    n.reminderAt = ts; n.reminderFired = false;
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    toast(`Hatırlatıcı kuruldu: ${whenLabel(ts)}`);
  } else {
    return;
  }
  renderEditor();
  if (!(state.pending?.id === n.id && isEmpty(n))) await commit();
  scheduleReminders();
});

/* ---------- Backup ---------- */
// The same data goes into the file backup and the cloud backup.
// Hidden notes stay sealed in it; the vault (salts, wrapped keys, check blocks) travels along so
// they can be opened on another device with their password.
const backupData = () => ({
  app: 'palet', version: 1, exportedAt: new Date().toISOString(), notes: state.notes,
  ...(sec.meta ? { vault: exportVault(sec.meta) } : {}),
});
function exportBackup() {
  const data = backupData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `takjot-yedek-${dayKey(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`${state.notes.length} not yedek dosyasına yazıldı`);
}
// Brings backup data in. Used by "Dosyadan geri yükle" and by the cloud restore.
// merge (default): new notes are added, a note is replaced only by a newer copy of itself.
// replace: this device's notes become exactly the backup's notes.
// The database is written first; memory changes only after it succeeded.
async function importBackup(data, { replace = false } = {}) {
  const raw = Array.isArray(data) ? data : data?.notes;
  if (!Array.isArray(raw)) throw new Error('format');
  const incoming = [...new Map(raw.map(sanitize).filter(Boolean).map(n => [n.id, n])).values()];
  const inVault = sanitizeVault(data?.vault, { keepBio: false });
  if (state.editing && saveTimer) await commit();
  let added = 0; let updated = 0;
  const toWrite = [];
  if (replace) {
    toWrite.push(...incoming);
    added = incoming.length;
  } else {
    incoming.forEach(n => {
      const cur = state.notes.find(x => x.id === n.id);
      if (!cur) { toWrite.push(n); added++; }
      // A note hidden here stays hidden: an older plain copy from a backup never replaces it.
      else if (isHidden(cur) && !isHidden(n)) { /* keep the hidden one */ }
      else if (n.updatedAt > cur.updatedAt) { toWrite.push({ ...cur, ...n }); updated++; }
    });
  }
  // The vault: this device's keys plus the backup's, minus keys no note uses.
  const after = replace ? incoming : [...state.notes.filter(n => !toWrite.some(w => w.id === n.id)), ...toWrite];
  const used = new Set(after.filter(isHidden).map(n => n.enc.kid));
  const meta = sec.meta || inVault ? mergeVault(sec.meta, inVault, used, { replace }) : undefined;
  await dbWrite(toWrite, meta ?? (sec.meta ? null : undefined), { replace });
  if (replace) state.notes = incoming;
  else {
    toWrite.forEach(n => {
      const cur = state.notes.find(x => x.id === n.id);
      if (cur) Object.assign(cur, n); else state.notes.push(n);
    });
  }
  if (meta?.current !== sec.meta?.current) dropKey();
  sec.meta = meta ?? null;
  render();
  scheduleReminders();
  scheduleAutoBackup();
  return { added, updated, total: incoming.length, foreign: foreignKids() };
}
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    if (!data) throw new Error('format');
    const res = await importBackup(data);
    toast(res.added || res.updated ? `${res.added} not eklendi, ${res.updated} not güncellendi` : 'Yedekteki notların hepsi zaten burada');
    afterImport(res);
  } catch (err) {
    console.error(err?.name ?? 'import');
    toast(err?.message === 'format' ? 'Bu dosya okunamadı. TakJot’tan indirilen bir .json yedek dosyası seç.' : 'Notlar yazılamadı, bu cihazdaki notlar olduğu gibi duruyor.');
  }
});


/* ---------- Cloud backup (Google Drive, appDataFolder) ---------- */
const AUTO_EVERY = DAY;              // automatic backup at most once a day
const AUTO_CHECK_MS = 10 * 60000;    // while the app is open, look every 10 minutes
const AUTO_RETRY_MS = 30 * 60000;    // after a failed automatic try, wait before the next
const auth = createAuth();
const drive = createDrive({
  fetchFn: (...a) => fetch(...a),
  getToken: () => auth.token(),
  refreshToken: () => auth.request({ quiet: true, hint: state.prefs.cloud.email || undefined }),
});
let sessionPw = null;                // the backup password, in memory for this session only
let cloudBusy = false;
let autoTimer = 0;
let autoFailedAt = 0;

const fullWhen = ts => `${fmtDayYear.format(ts)} ${fmtTime.format(ts)}`;
const CLOUD_MSG = {
  network: 'İnternete ulaşılamadı. Bağlantı gelince tekrar dene; notların bu cihazda olduğu gibi duruyor.',
  auth: 'Google oturumunun süresi doldu. Bağlantıyı yenileyip tekrar dene.',
  denied: 'Google izni verilmedi. Yedek için Drive’daki uygulama klasörüne erişim izni gerekiyor.',
  'popup-closed': 'Google penceresi kapandı. Hazır olduğunda tekrar dene.',
  'popup-blocked': 'Google penceresi açılamadı. Tekrar dokun; olmazsa tarayıcının açılır pencere ayarına bak.',
  'wrong-password': 'Şifre yanlış',
  corrupt: 'Bu yedek okunamadı, dosya bozulmuş olabilir. Başka bir yedek seç.',
  quota: 'Google Drive alanı dolu. Biraz yer açıp tekrar dene.',
  notfound: 'Bu yedek artık Drive’da yok. Listeyi yeniden açıp tekrar dene.',
  server: 'Google Drive şu an yanıt vermiyor. Biraz sonra tekrar dene.',
  'weak-password': 'Şifre en az 8 karakter olmalı.',
  consent: 'Bulut yedeği için önce onay gerekiyor. Buluta kaydet’e dokunup onayı verebilirsin.',
};
// The sign-in screen says what to do next, never who is to blame.
const LOGIN_MSG = {
  'popup-blocked': 'Google penceresi açılamadı. Tarayıcı açılır pencereyi engellemiş olabilir; bu site için izin verip yeniden dene.',
  'popup-closed': 'Giriş tamamlanmadı. Hazır olduğunda yeniden “Google ile devam et”e dokun.',
  network: 'İnternete bağlanılamadı. Bağlantı gelince yeniden dene; notların bu cihazda olduğu gibi duruyor.',
  denied: 'Google bu hesapla girişe izin vermedi. TakJot şu an deneme aşamasında; yalnızca eklenmiş hesaplar girebiliyor. Başka bir hesapla dene. İzin ekranında Drive kutusu işaretli değilse onu da işaretle.',
};
const loginMessage = err => (err instanceof CloudError && LOGIN_MSG[err.code]) || 'Google ile giriş şu an olmadı. Biraz sonra yeniden dene.';
const hasConsent = () => !!state.prefs.cloudConsentAt;
const cloudMessage = err => (err instanceof CloudError && CLOUD_MSG[err.code]) || 'Bir şey ters gitti. Notların olduğu gibi duruyor; tekrar dene.';

// A fingerprint of the notes, to tell whether anything changed since the last backup.
const notesSignature = () => String(hashStr(JSON.stringify([...state.notes].sort((a, b) => (a.id < b.id ? -1 : 1)))));

/* Dialog with fields. onSubmit(value, fields) may return { error } to stay open and show it
   ({ error, shake: true } also gives the dialog a short shake), or throw a CloudError, which is
   shown the same way. Resolves to null when cancelled.
   onOpen(form, ctl) may return { refresh, cleanup }: refresh runs whenever the fields are enabled
   again, cleanup when the dialog closes. onAction(act, button, ctl) handles buttons with data-act.
   ctl: { done(value), error(message), form }. */
function formDialog({ title, html = '', actions, onSubmit, onAction, onOpen }) {
  const dlg = $('#dlg-cloud');
  const form = $('#cloud-form');
  form.innerHTML = `<h2 id="cloud-title" class="dlg-title">${esc(title)}</h2>${html}<p class="form-error" role="alert" hidden></p>
    <div class="dlg-actions cloud-actions">${actions.map(a => `<button class="btn ${a.kind ?? 'ghost'}" type="submit" value="${esc(a.value)}">${esc(a.label)}</button>`).join('')}</div>`;
  const errEl = form.querySelector('.form-error');
  return new Promise(resolve => {
    let busy = false; let done = false; let hooks = {};
    const finish = v => {
      if (done) return;
      done = true;
      hooks.cleanup?.();
      form.onsubmit = null; form.onclick = null; form.onkeydown = null; dlg.oncancel = null;
      dlg.close();
      form.innerHTML = ''; // nothing typed (passwords) stays in the page
      resolve(v);
    };
    const showError = msg => { errEl.textContent = msg; errEl.hidden = !msg; };
    const ctl = { done: finish, error: showError, form };
    form.onsubmit = async e => {
      e.preventDefault();
      if (busy) return;
      const btn = e.submitter;
      const value = btn?.value ?? actions[actions.length - 1].value;
      if (value === 'cancel') { finish(null); return; }
      if (!onSubmit) { finish({ value }); return; }
      const fields = Object.fromEntries(new FormData(form));
      const act = actions.find(a => a.value === value);
      const label = btn?.textContent;
      busy = true;
      showError('');
      form.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
      if (btn && act?.busy) btn.textContent = act.busy;
      let r;
      try { r = await onSubmit(value, fields); } catch (err) {
        if (err?.code === 'auth') auth.clear();
        r = { error: cloudMessage(err) };
      }
      busy = false;
      if (done) return;
      form.querySelectorAll('button, input').forEach(el => { el.disabled = false; });
      if (btn && label) btn.textContent = label;
      hooks.refresh?.();
      if (r?.error) {
        showError(r.error);
        if (r.shake) {
          navigator.vibrate?.(40);
          if (!reduceMotion.matches) dlg.animate([{ translate: '0' }, { translate: '-10px' }, { translate: '9px' }, { translate: '-6px' }, { translate: '3px' }, { translate: '0' }], { duration: 320, easing: 'ease-out' });
        }
        (form.querySelector('input[type="password"]') ?? btn)?.focus();
        form.querySelector('input[type="password"]')?.select();
        return;
      }
      finish(r === undefined ? { value } : r);
    };
    form.onclick = e => {
      const b = e.target.closest('button[data-act]');
      if (b && onAction && !busy) onAction(b.dataset.act, b, ctl);
    };
    // Enter in a field means the main button (the last one), never the first ("Vazgeç").
    form.onkeydown = e => {
      if (e.key !== 'Enter' || e.isComposing || !e.target.matches('input:not([type="checkbox"])')) return;
      e.preventDefault();
      const main = form.querySelector('.cloud-actions button:last-child');
      if (main && !main.disabled && !busy) form.requestSubmit(main);
    };
    dlg.oncancel = e => { e.preventDefault(); if (!busy) finish(null); };
    dlg.showModal();
    hooks = onOpen?.(form, ctl) ?? {};
    (form.querySelector('input:not(:disabled)') ?? form.querySelector('.btn.primary'))?.focus();
  });
}
const CANCEL = { value: 'cancel', label: 'Vazgeç' };
const pwFields = ({ twice = false, label = 'Yedek şifresi' } = {}) => `
  <label class="field-label" for="cf-pw">${esc(label)}</label>
  <input id="cf-pw" name="pw" class="field" type="password" autocomplete="${twice ? 'new-password' : 'current-password'}" spellcheck="false" autocapitalize="off">
  ${twice ? `<label class="field-label" for="cf-pw2">Şifre (tekrar)</label>
  <input id="cf-pw2" name="pw2" class="field" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off">
  <p class="hint">En az 8 karakter.</p>` : ''}`;
const newPasswordError = f => checkPassword(f.pw ?? '') || (f.pw !== f.pw2 ? 'İki şifre aynı değil. İkisini de aynı yaz.' : null);
const NO_RECOVERY = '<p class="dlg-text"><strong>Şifreyi unutursan notlar kimse tarafından kurtarılamaz, biz de kurtaramayız.</strong> Şifreyi güvenli bir yere yaz.</p>';

// Opens Google's window. Call it straight from a tap, so the browser lets the window open.
function connectNow() {
  const hint = state.prefs.cloud.email || undefined;
  return gisReady() ? auth.request({ hint }) : loadGis().then(() => auth.request({ hint }));
}
function connectDialog(text, label = 'Google ile bağlan', title = 'Google hesabı') {
  return formDialog({
    title, html: `<p class="dlg-text">${esc(text)}</p>`,
    actions: [CANCEL, { value: 'ok', label, kind: 'primary', busy: 'Bağlanıyor…' }],
    onSubmit: async () => { auth.clear(); await connectNow(); },
  });
}
// A valid token, or a reason why not. Opens Google's window at once when it can,
// otherwise asks for one more tap.
async function ensureToken() {
  if (auth.valid()) return;
  if (gisReady()) {
    try { await connectNow(); return; } catch (e) { if (e?.code !== 'popup-blocked') throw e; }
  }
  const ok = await connectDialog('Devam etmek için Google hesabına bağlan.');
  if (!ok) throw new CloudError('cancelled');
}
async function noteConnected() {
  const c = state.prefs.cloud;
  c.connected = true;
  if (!c.email) c.email = (await drive.email()) || '';
  savePrefs();
}

async function cloudTask(fn) {
  if (cloudBusy) { toast('Bir bulut işlemi sürüyor. Bitince tekrar dene.'); return; }
  cloudBusy = true;
  try { await runCloud(fn); } finally { cloudBusy = false; refreshPendingMark(); }
}
async function runCloud(fn, retried = false) {
  try { return await fn(); } catch (e) {
    if (e?.code === 'cancelled') return undefined;
    if (e?.code === 'auth' && !retried) {
      auth.clear();
      const ok = await connectDialog('Google oturumunun süresi doldu. Devam etmek için bağlantıyı yenile.', 'Google bağlantısını yenile', 'Google bağlantısı');
      return ok ? runCloud(fn, true) : undefined;
    }
    toast(cloudMessage(e));
    return undefined;
  }
}

// Wrong password for the newest encrypted backup? Then this is not the current password.
async function verifyPassword(pw) {
  const latest = (await drive.list()).find(f => f.enc);
  if (!latest) return;
  const env = await drive.download(latest.id);
  try { await decryptBackup(env, pw); } catch (e) { if (e.code === 'wrong-password') throw e; }
}

// Encrypts this device's notes and uploads them; keeps the newest three backups.
// Settings and the session password change only after the upload succeeded.
async function doBackup({ pw, encrypt }) {
  if (!hasConsent()) throw new CloudError('consent');
  if (state.editing && saveTimer) await commit();
  const sig = notesSignature();
  const env = await encryptBackup(backupData(), encrypt ? pw : null);
  const file = await drive.create(env);
  await drive.prune(file.id).catch(() => {});
  const c = state.prefs.cloud;
  Object.assign(c, { setup: true, encrypt, lastBackupAt: file.createdAt || Date.now(), lastHash: sig });
  sessionPw = encrypt ? pw : null;
  autoFailedAt = 0;
  await noteConnected().catch(() => savePrefs());
  return file;
}
async function backupNow(opts) {
  toast('Buluta kaydediliyor…');
  const file = await doBackup(opts);
  toast(`${file.noteCount} not buluta kaydedildi`);
}

function cloudSave() {
  loadGis().catch(() => {});
  cloudTask(async () => {
    await cloudGate();
    const c = state.prefs.cloud;
    if (!c.setup) return setupFlow();
    if (c.encrypt && !sessionPw) return passwordThenBackup();
    await ensureToken();
    return backupNow({ pw: sessionPw, encrypt: c.encrypt });
  });
}

/* Sign-in screen and consent screen. Both live in one full-screen dialog (#dlg-gate).
   The sign-in uses the same Google flow as everywhere else (connectNow). */
const gateEl = {
  dlg: $('#dlg-gate'), login: $('#gate-login'), consent: $('#gate-consent'),
  google: $('#gate-google'), error: $('#gate-error'), box: $('#consent-box'), ok: $('#consent-ok'),
};
let gateDone = null; // resolves the screen that is showing: true = go on, false = not now
function showGate(panel) {
  const login = panel === 'login';
  gateEl.login.hidden = !login;
  gateEl.consent.hidden = login;
  gateEl.dlg.setAttribute('aria-labelledby', login ? 'gate-title' : 'consent-title');
  if (!gateEl.dlg.open) gateEl.dlg.showModal();
  (login ? gateEl.google : gateEl.box).focus();
  return new Promise(resolve => { gateDone = resolve; });
}
function finishGate(ok) {
  const r = gateDone;
  gateDone = null;
  r?.(ok);
}
function closeGate() { if (gateEl.dlg.open) gateEl.dlg.close(); }
function setGateError(msg) { gateEl.error.textContent = msg; gateEl.error.hidden = !msg; }
function setGateBusy(busy) {
  gateEl.google.disabled = busy;
  gateEl.google.querySelector('.g-label').textContent = busy ? 'Google bekleniyor…' : 'Google ile devam et';
}

gateEl.google.addEventListener('click', () => {
  if (gateEl.google.disabled) return;
  setGateError('');
  if (navigator.onLine === false) { setGateError(LOGIN_MSG.network); return; }
  setGateBusy(true);
  // Straight from the tap, so the browser lets Google's window open.
  let p;
  try { p = connectNow(); } catch (e) { p = Promise.reject(e); }
  p.then(async () => {
    await noteConnected().catch(() => { state.prefs.cloud.connected = true; savePrefs(); });
    setGateBusy(false);
    finishGate(true);
  }, err => {
    setGateBusy(false);
    setGateError(loginMessage(err));
    gateEl.google.focus();
  });
});
$('#gate-later').addEventListener('click', () => finishGate(false));
gateEl.box.addEventListener('change', () => { gateEl.ok.disabled = !gateEl.box.checked; });
gateEl.consent.addEventListener('submit', e => {
  e.preventDefault();
  if (!gateEl.box.checked) return;
  state.prefs.cloudConsentAt = new Date().toISOString();
  savePrefs();
  finishGate(true);
});
$('#consent-cancel').addEventListener('click', () => finishGate(false));
// Escape: the same as "Şimdi değil" / "Vazgeç".
gateEl.dlg.addEventListener('cancel', e => { e.preventDefault(); finishGate(false); });

// Before any cloud backup or restore: a Google session, then consent (asked once).
async function cloudGate() {
  try {
    if (!auth.valid()) {
      setGateError('');
      setGateBusy(false);
      if (!(await showGate('login'))) throw new CloudError('cancelled');
    }
    if (!hasConsent()) {
      gateEl.box.checked = false;
      gateEl.ok.disabled = true;
      if (!(await showGate('consent'))) throw new CloudError('cancelled');
    }
  } finally {
    closeGate();
  }
}

// First "Buluta kaydet": what happens, the password twice, then Google.
async function setupFlow() {
  const r = await formDialog({
    title: 'Buluta kaydet',
    html: `<p class="dlg-text">Notların, Google Drive’ında yalnızca TakJot’un görebildiği gizli bir klasöre kaydedilir. Bu yedek Drive listende görünmez.</p>
      <p class="dlg-text">Yedek, gönderilmeden önce bu cihazda belirlediğin şifreyle kilitlenir. Son 3 yedek tutulur.</p>
      ${NO_RECOVERY}${pwFields({ twice: true })}`,
    actions: [CANCEL, auth.valid()
      ? { value: 'ok', label: 'Şifreyi belirle ve kaydet', kind: 'primary', busy: 'Kaydediliyor…' }
      : { value: 'ok', label: 'Google ile bağlan ve kaydet', kind: 'primary', busy: 'Google bekleniyor…' }],
    onSubmit: async (v, f) => {
      const bad = newPasswordError(f);
      if (bad) return { error: bad };
      if (!auth.valid()) await connectNow();
      return { pw: f.pw };
    },
  });
  if (!r) return;
  await noteConnected();
  const files = await drive.list();
  if (files.length) {
    const pick = await formDialog({
      title: 'Drive’da yedeklerin var',
      html: `<p class="dlg-text">Bu hesapta ${files.length} TakJot yedeği bulundu (en yenisi ${esc(fullWhen(files[0].createdAt))}). Yeni yedek bunlara eklenir, en eski olanlar silinir.</p>
        <p class="dlg-text">Başka bir cihazdan geliyorsan önce geri yüklemek isteyebilirsin.</p>`,
      actions: [CANCEL, { value: 'restore', label: 'Önce geri yükle', kind: 'outline' }, { value: 'save', label: 'Yeni yedek oluştur', kind: 'primary' }],
    });
    if (!pick) return;
    if (pick.value === 'restore') { await restoreFrom(files, r.pw); return; }
  }
  await backupNow({ pw: r.pw, encrypt: true });
}

// A new session: ask for the password once and check it against the newest backup.
async function passwordThenBackup() {
  const r = await formDialog({
    title: 'Yedek şifresi',
    html: `<p class="dlg-text">Yedeği kilitlemek için yedek şifreni gir. Bu oturumda tekrar sorulmaz.</p>${pwFields()}
      <p class="hint">Unuttuysan Bulut ayarlarından yeni şifre belirleyebilirsin; eski yedekler o zaman açılamaz.</p>`,
    actions: [CANCEL, { value: 'ok', label: 'Buluta kaydet', kind: 'primary', busy: 'Kontrol ediliyor…' }],
    onSubmit: async (v, f) => {
      if (!f.pw) return { error: 'Yedek şifreni yaz.' };
      if (!auth.valid()) await connectNow();
      await verifyPassword(f.pw);
      return { pw: f.pw };
    },
  });
  if (!r) return;
  await backupNow({ pw: r.pw, encrypt: true });
}

function cloudRestore() {
  loadGis().catch(() => {});
  cloudTask(async () => {
    await cloudGate();
    await ensureToken();
    await noteConnected();
    toast('Yedekler aranıyor…');
    await restoreFrom(await drive.list());
  });
}

function pickBackup(files) {
  return new Promise(resolve => {
    showSheet('Hangi yedek geri yüklensin?', files.map(f => ({
      icon: f.enc ? 'lock' : 'cloud',
      label: fullWhen(f.createdAt),
      sub: `${f.noteCount} not · ${f.enc ? 'şifreli' : 'şifresiz'}`,
      run: () => resolve(f),
    })), { onClose: () => resolve(null) });
  });
}

async function restoreFrom(files, pwHint) {
  if (!hasConsent()) throw new CloudError('consent');
  hideToast();
  if (!files.length) {
    await formDialog({
      title: 'Yedek bulunamadı',
      html: '<p class="dlg-text">Bu Google hesabının Drive’ında TakJot yedeği yok. Yedeği aldığın hesapla bağlandığından emin ol ya da önce bir cihazdan Buluta kaydet.</p>',
      actions: [{ value: 'cancel', label: 'Tamam', kind: 'primary' }],
    });
    return;
  }
  const file = await pickBackup(files);
  if (!file) return;
  toast('Yedek indiriliyor…');
  const env = await drive.download(file.id);
  hideToast();
  let data = null; let pw = null;
  if (env.enc) {
    for (const p of [sessionPw, pwHint].filter(Boolean)) {
      try { data = await decryptBackup(env, p); pw = p; break; } catch (e) { if (e.code !== 'wrong-password') throw e; }
    }
    if (!data) {
      const r = await formDialog({
        title: 'Yedek şifresi',
        html: `<p class="dlg-text">${esc(fullWhen(file.createdAt))} tarihli yedek şifreli. Açmak için yedeği alırken belirlediğin şifreyi gir.</p>${pwFields()}`,
        actions: [CANCEL, { value: 'ok', label: 'Yedeği aç', kind: 'primary', busy: 'Açılıyor…' }],
        onSubmit: async (v, f) => {
          if (!f.pw) return { error: 'Yedek şifreni yaz.' };
          return { data: await decryptBackup(env, f.pw), pw: f.pw };
        },
      });
      if (!r) return;
      ({ data, pw } = r);
    }
  } else {
    data = await decryptBackup(env, null);
  }

  const incoming = (Array.isArray(data) ? data : data.notes).length;
  const here = state.notes.length;
  const mode = await formDialog({
    title: 'Yedeği geri yükle',
    html: `<p class="dlg-text">Yedekte ${incoming} not var, bu cihazda ${here} not var.</p>
      ${here ? `<p class="dlg-text">İstersen önce bu cihazdaki notları dosya olarak indir.</p>
      <button class="btn outline cloud-extra" type="button" data-act="download">${icon('download')}<span>Mevcut notları indir</span></button>` : ''}
      <p class="hint"><b>Ekle:</b> yedekteki notlar eklenir, aynı notun daha yeni hâli varsa güncellenir. <b>Yerine koy:</b> bu cihazdaki notlar silinir, yalnızca yedektekiler kalır.</p>`,
    actions: [CANCEL, { value: 'replace', label: 'Mevcut notların yerine koy', kind: 'outline' }, { value: 'merge', label: 'Mevcut notlara ekle', kind: 'primary' }],
    onAction: (act, btn) => {
      if (act !== 'download') return;
      exportBackup();
      btn.disabled = true;
      btn.innerHTML = `${icon('check')}<span>İndirildi</span>`;
    },
  });
  if (!mode) return;
  const replace = mode.value === 'replace';
  if (replace && here) {
    const ok = await confirmDialog({
      title: 'Mevcut notlar değiştirilsin mi?',
      body: `Bu cihazdaki ${here} not silinecek, yerine yedekteki ${incoming} not gelecek. Bu işlem geri alınamaz.`,
      ok: 'Yerine koy',
    });
    if (!ok) return;
  }
  let res;
  try { res = await importBackup(data, { replace }); } catch (err) {
    console.error(err?.name ?? 'import');
    toast('Notlar yazılamadı, bu cihazdaki notlar olduğu gibi duruyor. Depolama alanını kontrol edip tekrar dene.');
    return;
  }
  const c = state.prefs.cloud;
  if (env.enc && pw) { sessionPw = pw; if (!c.setup) { c.setup = true; c.encrypt = true; } }
  c.lastBackupAt = Math.max(c.lastBackupAt || 0, files[0].createdAt || 0);
  if (replace && file.id === files[0].id) c.lastHash = notesSignature();
  savePrefs();
  toast(replace ? `${res.added} not geri yüklendi` : (res.added || res.updated ? `${res.added} not eklendi, ${res.updated} not güncellendi` : 'Yedekteki notların hepsi zaten burada'));
  afterImport(res);
}

/* Settings: account, password, encryption, automatic backup */
function cloudSettings() {
  loadGis().catch(() => {});
  const c = state.prefs.cloud;
  const locked = c.setup && c.encrypt;
  const info = c.connected
    ? `${icon('cloud')}<span><small>Bağlı hesap</small><b>${esc(c.email || 'Google hesabı')}</b></span>`
    : `${icon('cloud')}<span><small>Google hesabı</small><b>Bağlı değil</b></span>`;
  showSheet('Bulut ayarları', [
    c.connected
      ? { icon: 'close', label: 'Bağlantıyı kes', run: disconnectCloud }
      : { icon: 'cloud', label: 'Google hesabına bağlan', run: () => cloudTask(async () => { auth.clear(); await ensureToken(); await noteConnected(); toast('Google hesabına bağlandı'); }) },
    { icon: 'lock', label: locked ? 'Yedek şifresini değiştir' : 'Yedek şifresini belirle', run: () => cloudTask(changePassword) },
    locked && { icon: 'unlock', label: 'Şifrelemeyi kapat', danger: true, run: disableEncryption },
    hasConsent() && {
      icon: 'shield', label: 'Rızayı geri al ve bağlantıyı kes', danger: true,
      sub: `Onay tarihi: ${fullWhen(Date.parse(state.prefs.cloudConsentAt) || Date.now())}`,
      run: withdrawConsent,
    },
    {
      icon: 'sync', label: 'Otomatik yedek', toggle: c.auto, keep: true,
      sub: c.auto ? 'Açık · uygulama açıkken, günde en fazla bir kez' : 'Kapalı',
      run: b => {
        c.auto = !c.auto;
        savePrefs();
        b.setAttribute('aria-checked', String(c.auto));
        b.querySelector('.sheet-sub').textContent = c.auto ? 'Açık · uygulama açıkken, günde en fazla bir kez' : 'Kapalı';
        refreshPendingMark();
        if (c.auto) scheduleAutoBackup();
      },
    },
  ], { info });
}

async function changePassword() {
  const c = state.prefs.cloud;
  const locked = c.setup && c.encrypt;
  await formDialog({
    title: locked ? 'Yedek şifresini değiştir' : 'Yedek şifresini belirle',
    html: `<p class="dlg-text">Yeni şifreyle hemen yeni bir yedek alınır. Eski yedekler eski şifreleriyle açılır.</p>${NO_RECOVERY}${pwFields({ twice: true, label: 'Yeni şifre' })}`,
    actions: [CANCEL, { value: 'ok', label: 'Kaydet ve yedekle', kind: 'primary', busy: 'Kaydediliyor…' }],
    onSubmit: async (v, f) => {
      const bad = newPasswordError(f);
      if (bad) return { error: bad };
      if (!auth.valid()) await connectNow();
      await doBackup({ pw: f.pw, encrypt: true });
      return { value: 'ok' };
    },
  }).then(r => { if (r) toast('Yeni şifre geçerli, yeni yedek alındı'); });
}

async function disableEncryption() {
  const ok = await confirmDialog({
    title: 'Şifreleme kapatılsın mı?',
    body: 'Bundan sonraki yedekler şifresiz kaydedilir. Google hesabına erişebilen biri bu yedeklerdeki notları okuyabilir. Önceki şifreli yedekler şifreli kalır.',
    ok: 'Şifrelemeyi kapat',
  });
  if (!ok) return;
  const c = state.prefs.cloud;
  c.encrypt = false;
  c.setup = true;
  sessionPw = null;
  savePrefs();
  toast('Şifreleme kapatıldı. Sonraki yedekler şifresiz kaydedilecek.');
}

async function disconnectCloud() {
  const ok = await confirmDialog({
    title: 'Google bağlantısı kesilsin mi?',
    body: 'Drive’daki yedeklerin silinmez; tekrar bağlandığında yine görürsün. Bu cihazdaki notlar olduğu gibi kalır.',
    ok: 'Bağlantıyı kes',
  });
  if (!ok) return;
  auth.revoke();
  sessionPw = null;
  state.prefs.cloud = { ...DEFAULT_CLOUD };
  savePrefs();
  refreshPendingMark();
  toast('Google bağlantısı kesildi');
}

// Withdraws cloud consent: the connection is cut and the consent date is removed.
// Until consent is given again, no backup or restore runs (automatic backup included).
async function withdrawConsent() {
  const ok = await confirmDialog({
    title: 'Rıza geri alınsın mı?',
    body: 'Google bağlantısı kesilir ve bulut yedeği durur. Drive’daki eski yedeklerin silinmez. Bu cihazdaki notlar olduğu gibi kalır. Yeniden yedek almak istersen onayın tekrar sorulur.',
    ok: 'Rızayı geri al',
  });
  if (!ok) return;
  auth.revoke();
  sessionPw = null;
  state.prefs.cloud = { ...DEFAULT_CLOUD };
  delete state.prefs.cloudConsentAt;
  savePrefs();
  refreshPendingMark();
  toast('Rıza geri alındı, Google bağlantısı kesildi');
}

/* Automatic backup: only while the app is open, at most once a day, only after changes,
   and only with a token and password already in memory. Otherwise it waits and says so. */
function autoState() {
  const c = state.prefs.cloud;
  if (!c.auto || !hasConsent()) return 'off';
  if (c.lastHash && notesSignature() === c.lastHash) return 'clean';
  if (Date.now() - (c.lastBackupAt || 0) < AUTO_EVERY) return 'wait';
  if (!c.setup || !auth.valid() || (c.encrypt && !sessionPw) || navigator.onLine === false) return 'pending';
  if (autoFailedAt && Date.now() - autoFailedAt < AUTO_RETRY_MS) return 'pending';
  return 'due';
}
function refreshPendingMark() {
  const waiting = autoState() === 'pending';
  const btn = $('#menu-btn');
  btn.classList.toggle('has-dot', waiting);
  btn.setAttribute('aria-label', waiting ? 'Görünüm ve yedek seçenekleri, yedek bekliyor' : 'Görünüm ve yedek seçenekleri');
}
function scheduleAutoBackup() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(maybeAutoBackup, 15000);
}
async function maybeAutoBackup() {
  const s = autoState();
  refreshPendingMark();
  if (s !== 'due' || cloudBusy || state.editing || document.visibilityState === 'hidden') return;
  const c = state.prefs.cloud;
  cloudBusy = true;
  try { await doBackup({ pw: sessionPw, encrypt: c.encrypt }); } catch { autoFailedAt = Date.now(); } finally {
    cloudBusy = false;
    refreshPendingMark();
  }
}

/* ---------- Hidden notes (vault.js) ----------
   A hidden note is kept sealed: in the list, on disk and in backups only its colour, dates, pin and
   position are readable. Its content is decrypted into a copy (secret: true) only while it is open.
   The note key lives in memory only, and is dropped when the notes lock. */
const sec = { meta: null, key: null, hiddenAt: 0, lockTimer: 0 };
const LOCK_AFTER = { 0: 'Hemen', 30: '30 saniye', 60: '1 dakika', 300: '5 dakika' };
const lockAfterLabel = () => {
  const a = state.prefs.secretAfter;
  return a && LOCK_AFTER[a] ? `${LOCK_AFTER[a]} sonra kilitlenir` : 'arka plana geçince kilitlenir';
};
const VISIBLE = ['color', 'pinned', 'archived', 'deletedAt', 'reminderAt', 'reminderFired', 'createdAt', 'updatedAt'];
function visibleFields(n) {
  const o = {};
  VISIBLE.forEach(k => { o[k] = n[k]; });
  if (Number.isFinite(n.order)) o.order = n.order;
  return o;
}
const SEALED_EMPTY = { type: 'text', title: '', body: '', items: [] };

// The stored form of an open hidden note. The key is taken at once, so a lock that comes
// while this runs cannot stop the content being sealed.
async function sealedRecord(n) {
  const key = sec.key; const kid = sec.meta?.current;
  const enc = key && kid ? await sealNote(key, kid, n) : null;
  const cur = state.notes.find(x => x.id === n.id);
  if (!enc && !isHidden(cur)) throw new VaultError('locked');
  // Locked meanwhile (an "undo" after the lock, say): the sealed content stays, only the visible fields change.
  const rec = isHidden(cur) ? cur : { id: n.id };
  Object.assign(rec, visibleFields(n), SEALED_EMPTY, enc ? { enc } : {});
  return rec;
}
function dropKey() { sec.key = null; state.openSecret = null; }
function foreignKids() {
  const cur = sec.meta?.current;
  return [...new Set(state.notes.filter(n => isHidden(n) && n.enc.kid !== cur).map(n => n.enc.kid))];
}

/* Wrong passwords: counted on the device (survives a reload); after 5 in a row, waits grow. */
function noteFail() { state.prefs.secretLock = failedTry(state.prefs.secretLock); savePrefs(); return lockRemaining(state.prefs.secretLock); }
function clearFails() { if (state.prefs.secretLock) { delete state.prefs.secretLock; savePrefs(); } }
const waitText = ms => { const s = Math.ceil(ms / 1000); return s >= 60 ? `${Math.ceil(s / 60)} dakika` : `${s} saniye`; };
const lockedMsg = ms => `Çok fazla yanlış deneme. ${waitText(ms)} sonra tekrar dene.`;

/* Biometric unlock: only with WebAuthn PRF, where the fingerprint or face check makes the
   authenticator produce a secret that opens the note key. No PRF, no biometric option. */
let bioSupport = null; // 'yes' | 'maybe' (unknown until tried) | 'no'
async function checkBio() {
  if (bioSupport) return bioSupport;
  let r = 'no';
  try {
    if (window.isSecureContext && window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()) {
      r = 'maybe';
      const caps = await PublicKeyCredential.getClientCapabilities?.();
      if (caps && 'extension:prf' in caps) r = caps['extension:prf'] ? 'yes' : 'no';
    }
  } catch { r = 'no'; }
  bioSupport = r;
  return r;
}
const b64url = b64 => b64.replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
function forgetCredential(credId) {
  try { PublicKeyCredential.signalUnknownCredential?.({ rpId: location.hostname, credentialId: b64url(credId) })?.catch?.(() => {}); } catch { /* not supported */ }
}
const prfOut = cred => cred?.getClientExtensionResults?.()?.prf?.results?.first;
function bioGet(credId, prf) {
  return navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rpId: location.hostname,
    allowCredentials: [{ type: 'public-key', id: fromB64(credId), transports: ['internal'] }],
    userVerification: 'required', timeout: 60000,
    extensions: { prf: { eval: { first: fromB64(prf) } } },
  } });
}
// Called straight from a tap: the browser asks for the fingerprint or face.
async function bioUnlock() {
  const b = sec.meta.bio;
  const out = prfOut(await bioGet(b.credId, b.prf));
  if (!out) throw new VaultError('unsupported');
  return unwrapWithSecret(b, new Uint8Array(out), sec.meta.keys[b.kid]);
}

/* Asks for the password of vault key kid. Resolves to { key } or null (cancelled).
   A right password for the current key also unlocks the session. */
function askPassword({ kid, title = 'Gizli not', text, action = 'Aç', extractable = false, allowForgot = true, allowBio = true, danger = false, alsoCurrent = false }) {
  const entry = sec.meta?.keys?.[kid];
  if (!entry) { toast('Bu notun şifre bilgisi bu cihazda yok. Not olduğu gibi duruyor.'); return Promise.resolve(null); }
  const bioOk = allowBio && !extractable && kid === sec.meta.current && sec.meta.bio?.kid === kid && bioSupport !== 'no' && !!window.PublicKeyCredential;
  return formDialog({
    title,
    html: `<p class="dlg-text">${esc(text)}</p>
      <label class="field-label" for="cf-pw">Gizli not şifresi</label>
      <input id="cf-pw" name="pw" class="field" type="password" autocomplete="current-password" spellcheck="false" autocapitalize="off">
      ${bioOk ? `<button class="btn outline cloud-extra" type="button" data-act="bio">${icon('finger')}<span>Parmak izi / yüz ile aç</span></button>` : ''}
      ${allowForgot ? '<button class="gate-link small secret-forgot" type="button" data-act="forgot">Şifremi unuttum</button>' : ''}`,
    actions: [CANCEL, { value: 'ok', label: action, kind: danger ? 'danger' : 'primary', busy: 'Kontrol ediliyor…' }],
    onOpen: (form, ctl) => {
      const input = form.querySelector('#cf-pw');
      const ok = form.querySelector('button[value="ok"]');
      let shown = false;
      const refresh = () => {
        const left = lockRemaining(state.prefs.secretLock);
        input.disabled = ok.disabled = left > 0;
        if (left > 0) { ctl.error(lockedMsg(left)); shown = true; } else if (shown) { shown = false; ctl.error(''); input.focus(); }
      };
      refresh();
      const timer = setInterval(refresh, 1000);
      return { refresh, cleanup: () => clearInterval(timer) };
    },
    onSubmit: async (v, f) => {
      const left = lockRemaining(state.prefs.secretLock);
      if (left) return { error: lockedMsg(left) };
      if (!f.pw) return { error: 'Gizli not şifreni yaz.' };
      let key;
      try { key = await unlockEntry(entry, f.pw, { extractable }); } catch (e) {
        if (e?.code !== 'wrong-password') return { error: 'Şifre bilgisi okunamadı. Notlar olduğu gibi duruyor.' };
        const wait = noteFail();
        return { error: wait ? `Şifre yanlış. ${waitText(wait)} beklemen gerekiyor.` : 'Şifre yanlış', shake: true };
      }
      clearFails();
      // Same password on this device too? Then that opens as well, without asking twice.
      let cur = null;
      if (alsoCurrent && sec.meta.current && kid !== sec.meta.current && !sec.key) {
        try { cur = await unlockEntry(sec.meta.keys[sec.meta.current], f.pw); } catch { cur = null; }
      }
      return { key, cur };
    },
    onAction: (act, btn, ctl) => {
      if (act === 'forgot') { ctl.done(null); forgotSecret(); return; }
      if (act !== 'bio') return;
      let p;
      try { p = bioUnlock(); } catch (e) { p = Promise.reject(e); }
      btn.disabled = true;
      p.then(key => { clearFails(); ctl.done({ key }); }, e => {
        btn.disabled = false;
        ctl.error(e?.name === 'NotAllowedError' ? 'Doğrulama yapılmadı. Şifrenle de açabilirsin.' : 'Parmak izi / yüz ile açılamadı. Şifrenle aç.');
      });
    },
  }).then(r => {
    if (!r?.key) return null;
    if (kid === sec.meta?.current && !extractable) sec.key = r.key;
    if (r.cur) sec.key = r.cur;
    return r;
  });
}
// The current note key: from memory, or by asking for the password.
async function requireKey(text = 'Gizli notları açmak için gizli not şifreni gir.') {
  if (sec.key) return sec.key;
  if (!sec.meta?.current) return null;
  return (await askPassword({ kid: sec.meta.current, text })) ? sec.key : null;
}
// For deleting, restoring and un-hiding: the password is asked even when the notes are open.
async function confirmSecret({ kid, ...opts }) {
  const k = kid ?? sec.meta?.current;
  if (!k) return false;
  return !!(await askPassword({ ...opts, kid: k, allowForgot: false }));
}

// Strength bar and the "I understand" box for a new password.
function newSecretFields() {
  return `<label class="field-label" for="cf-pw">Şifre</label>
    <input id="cf-pw" name="pw" class="field" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" aria-describedby="cf-strength cf-pw-hint">
    <div class="strength" data-score="0" aria-hidden="true"><i></i><i></i><i></i></div>
    <p id="cf-strength" class="hint strength-label">En az 6 karakter</p>
    <p id="cf-pw-hint" class="hint">Sadece rakamlı kısa şifre telefon kopyalanırsa kırılabilir. 8+ karakter, harf ve rakam karışık önerilir.</p>
    <label class="field-label" for="cf-pw2">Şifre (tekrar)</label>
    <input id="cf-pw2" name="pw2" class="field" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off">
    <label class="consent-row secret-ack"><input type="checkbox" name="ack" value="1"><span class="consent-box" aria-hidden="true">${icon('check')}</span><span>Şifremi unutursam gizli notlarımın kurtarılamayacağını anlıyorum.</span></label>`;
}
function strengthMeter(form) {
  const pw = form.querySelector('#cf-pw');
  const bar = form.querySelector('.strength');
  const label = form.querySelector('.strength-label');
  const ack = form.querySelector('input[name="ack"]');
  const ok = form.querySelector('button[value="ok"]');
  const update = () => {
    const s = passwordStrength(pw.value);
    bar.dataset.score = pw.value ? String(s.score) : '0';
    label.textContent = pw.value ? `Şifre gücü: ${s.label}` : 'En az 6 karakter';
  };
  const refresh = () => { ok.disabled = !ack.checked; };
  pw.addEventListener('input', update);
  ack.addEventListener('change', refresh);
  update(); refresh();
  return { refresh };
}
const newSecretError = f => checkSecretPassword(f.pw ?? '')
  || (f.pw !== f.pw2 ? 'İki şifre aynı değil. İkisini de aynı yaz.' : null)
  || (!f.ack ? 'Devam etmek için kutuyu işaretle.' : null);

// First hidden note: the password is set here. Nothing is saved until the note itself is sealed.
async function setupSecret() {
  const r = await formDialog({
    title: 'Gizli not şifresi',
    html: `<p class="dlg-text">Gizli notlar bu şifreyle kilitlenir. Şifre hiçbir yere kaydedilmez; notu açarken sorulur.</p>
      ${newSecretFields()}
      <p class="hint">Banka şifresi gibi çok hassas bilgileri not almamanı öneririz.</p>`,
    actions: [CANCEL, { value: 'ok', label: 'Şifreyi belirle', kind: 'primary', busy: 'Hazırlanıyor…' }],
    onOpen: strengthMeter,
    onSubmit: async (v, f) => {
      const bad = newSecretError(f);
      if (bad) return { error: bad };
      return createVault(f.pw);
    },
  });
  if (!r) return null;
  return { key: r.key, meta: { id: 'vault', current: r.entry.kid, keys: { ...(sec.meta?.keys ?? {}), [r.entry.kid]: r.entry }, bio: null } };
}

// "Gizli yap": seal, open the sealed text again and compare, and only then replace the plain note.
async function makeHidden(n) {
  clearTimeout(saveTimer); saveTimer = null;
  if (isEmpty(n)) { toast('Boş not gizlenemez. Önce bir şey yaz.'); return; }
  const created = sec.meta?.current ? null : await setupSecret();
  if (!sec.meta?.current && !created) return;
  const key = created?.key ?? await requireKey('Notu gizlemek için gizli not şifreni gir.');
  if (!key || state.editing !== n) return;
  const meta = created?.meta ?? sec.meta;
  n.updatedAt = Date.now();
  let rec;
  try {
    const enc = await sealNote(key, meta.current, n);
    rec = { id: n.id, ...visibleFields(n), ...SEALED_EMPTY, enc };
    // One transaction: the vault (first time) and the sealed note, or nothing.
    await dbWrite([rec], created ? meta : undefined);
  } catch (err) {
    console.error(err?.name ?? 'hide');
    toast('Not gizlenemedi; not olduğu gibi duruyor.');
    return;
  }
  sec.meta = meta;
  sec.key = key;
  const i = state.notes.findIndex(x => x.id === n.id);
  if (i < 0) state.notes.push(rec); else state.notes[i] = rec;
  if (state.pending?.id === n.id) state.pending = null;
  n.secret = true;
  renderEditor();
  requestPersist();
  scheduleAutoBackup();
  toast(state.prefs.cloud.lastBackupAt ? 'Not gizlendi. Önceden alınmış yedeklerde açık hâli durabilir.' : 'Not gizlendi. Listede kilitli görünür.');
}

// Tapping a hidden note: password (or what is already open), then the editor.
async function openHidden(n) {
  if (!sec.meta?.keys?.[n.enc.kid]) { toast('Bu notun şifre bilgisi bu cihazda yok. Not olduğu gibi duruyor.'); return; }
  if (n.enc.kid !== sec.meta.current) {
    if (!(await adoptForeign(n.enc.kid))) return;
    n = state.notes.find(x => x.id === n.id);
    if (!n) return;
  }
  const key = await requireKey();
  if (!key) return;
  let content;
  try { content = await unsealNote(key, n.enc, n.id); } catch {
    toast('Bu gizli not açılamadı; veri bozulmuş olabilir. Not olduğu gibi duruyor.');
    return;
  }
  const { enc, ...rest } = n;
  state.openSecret = { ...rest, ...content, secret: true };
  openNote(n.id);
}

async function unhideNote(n) {
  if (!(await confirmSecret({ title: 'Gizliyi kaldır', text: 'Not normal nota döner; içeriği listede ve aramada görünür. Onaylamak için gizli not şifreni gir.', action: 'Gizliyi kaldır' }))) return;
  if (state.editing !== n) return;
  clearTimeout(saveTimer); saveTimer = null;
  delete n.secret;
  n.updatedAt = Date.now();
  try { await dbPut(n); } catch (err) {
    console.error(err?.name ?? 'unhide');
    n.secret = true;
    toast('Gizlilik kaldırılamadı; not gizli olarak duruyor.');
    return;
  }
  const i = state.notes.findIndex(x => x.id === n.id);
  if (i < 0) state.notes.push(n); else state.notes[i] = n;
  renderEditor();
  scheduleAutoBackup();
  toast('Gizlilik kaldırıldı. Not artık normal not.');
}

// New password: a new key; every hidden note is opened with the old key and sealed with the new one,
// then all of them and the vault are written in one transaction. Fails anywhere: nothing changes.
async function changeSecretPassword() {
  const kid = sec.meta?.current;
  if (!kid) return;
  const old = await askPassword({ kid, title: 'Şifreyi değiştir', text: 'Önce şu anki gizli not şifreni gir.', action: 'Devam', allowForgot: false, allowBio: false });
  if (!old) return;
  if (state.editing?.secret && saveTimer) await commit();
  const hadBio = !!sec.meta.bio;
  const r = await formDialog({
    title: 'Yeni gizli not şifresi',
    html: `<p class="dlg-text">Bütün gizli notlar yeni şifreyle yeniden kilitlenir. İşlem yarıda kalırsa notlar eski şifreyle kalır.</p>${newSecretFields()}`,
    actions: [CANCEL, { value: 'ok', label: 'Şifreyi değiştir', kind: 'primary', busy: 'Notlar kilitleniyor…' }],
    onOpen: strengthMeter,
    onSubmit: async (v, f) => {
      const bad = newSecretError(f);
      if (bad) return { error: bad };
      const { entry, key } = await createVault(f.pw);
      const sealed = new Map();
      for (const n of state.notes.filter(x => x.enc?.kid === kid)) {
        const content = await unsealNote(old.key, n.enc, n.id);
        sealed.set(n.id, await sealNote(key, entry.kid, { id: n.id, ...content }));
      }
      const keys = { ...sec.meta.keys, [entry.kid]: entry };
      delete keys[kid];
      const meta = { id: 'vault', current: entry.kid, keys, bio: null };
      const mine = state.notes.filter(x => x.enc?.kid === kid);
      if (mine.some(x => !sealed.has(x.id))) return { error: 'Notlar değişti; bir daha dene.' };
      await dbWrite(mine.map(x => ({ ...x, enc: sealed.get(x.id) })), meta);
      // Written: memory follows at once, so nothing can save with the old key in between.
      mine.forEach(x => { x.enc = sealed.get(x.id); });
      if (hadBio) forgetCredential(sec.meta.bio.credId);
      sec.meta = meta;
      sec.key = key;
      return { count: mine.length };
    },
  });
  if (!r) return;
  scheduleAutoBackup();
  toast(`Şifre değişti, ${r.count} gizli not yeni şifreyle kilitlendi${hadBio ? '. Parmak izini yeniden kurman gerekir' : ''}`);
}

// Only the hidden notes go, after the user types SİL. Other notes are not touched.
async function forgotSecret() {
  const ids = state.notes.filter(isHidden).map(n => n.id);
  const r = await formDialog({
    title: 'Şifremi unuttum',
    html: `<p class="dlg-text"><strong>Gizli not şifresi kurtarılamaz; biz de kurtaramayız.</strong></p>
      <p class="dlg-text">Devam edersen bu cihazdaki ${ids.length} gizli not (çöp kutusundakiler dahil) kalıcı olarak silinir. Diğer notlarına dokunulmaz. Sonra yeni bir şifreyle baştan başlayabilirsin.</p>
      <label class="field-label" for="cf-confirm">Onaylamak için SİL yaz</label>
      <input id="cf-confirm" name="confirm" class="field" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false">`,
    actions: [CANCEL, { value: 'ok', label: 'Gizli notları sil', kind: 'danger', busy: 'Siliniyor…' }],
    onSubmit: async (v, f) => {
      const word = String(f.confirm ?? '').trim().toLocaleUpperCase('tr');
      if (word !== 'SİL' && word !== 'SIL') return { error: 'Onaylamak için kutuya SİL yaz.' };
      await dbWrite([], null, { removeIds: ids });
      return { value: 'ok' };
    },
  });
  if (!r) return;
  if (state.editing?.secret) { closeEditor(); location.replace(`#/${state.view}`); }
  if (sec.meta?.bio) forgetCredential(sec.meta.bio.credId);
  state.notes = state.notes.filter(n => !ids.includes(n.id));
  dropKey();
  sec.meta = null;
  clearFails();
  if (state.kind === 'secret') state.kind = 'all';
  render();
  scheduleReminders();
  scheduleAutoBackup();
  toast(`${ids.length} gizli not silindi. Diğer notların duruyor.`);
}

// Notes sealed with a key from another device or an older backup: their password opens them once,
// then they are sealed again with this device's key (one transaction).
async function adoptForeign(kid) {
  const mine = () => state.notes.filter(n => n.enc?.kid === kid);
  const count = mine().length;
  const r = await askPassword({
    kid, title: 'Farklı şifreyle kilitli', action: 'Aç', allowForgot: false, allowBio: false, alsoCurrent: true,
    text: `${count > 1 ? `Bu ${count} not` : 'Bu not'} farklı bir gizli not şifresiyle şifrelenmiş (başka bir cihazdan ya da eski bir yedekten gelmiş). O şifreyi gir; ${count > 1 ? 'notlar' : 'not'} bu cihazdaki şifrene taşınır.`,
  });
  if (!r) return false;
  let key; let curKid;
  if (!sec.meta.current) { key = r.key; curKid = kid; } else {
    key = await requireKey('Şimdi bu cihazdaki gizli not şifreni gir; notlar onunla kilitlenecek.');
    if (!key) return false;
    curKid = sec.meta.current;
  }
  const meta = { ...sec.meta, current: curKid, keys: { ...sec.meta.keys } };
  try {
    const sealed = new Map();
    if (curKid !== kid) {
      for (const n of mine()) sealed.set(n.id, await sealNote(key, curKid, { id: n.id, ...(await unsealNote(r.key, n.enc, n.id)) }));
    }
    const list = mine().filter(n => sealed.has(n.id));
    if (curKid !== kid && mine().every(n => sealed.has(n.id))) delete meta.keys[kid];
    await dbWrite(list.map(n => ({ ...n, enc: sealed.get(n.id) })), meta);
    list.forEach(n => { n.enc = sealed.get(n.id); });
    sec.meta = meta;
    sec.key = key;
    if (list.length) toast(`${list.length} not bu cihazdaki şifreye taşındı`);
    return true;
  } catch (err) {
    console.error(err?.name ?? 'adopt');
    toast('Notlar taşınamadı; oldukları gibi duruyor.');
    return false;
  }
}
// After a restore: notes locked with another password stay locked and are not lost; offer to open them.
async function afterImport(res) {
  const kids = res?.foreign ?? [];
  if (!kids.length) return;
  const count = state.notes.filter(n => isHidden(n) && kids.includes(n.enc.kid)).length;
  const r = await formDialog({
    title: 'Farklı şifreli gizli notlar',
    html: `<p class="dlg-text">Bu notlar farklı bir gizli not şifresiyle şifrelenmiş (${count} not). Notlar kaybolmadı, kilitli duruyorlar.</p>
      <p class="dlg-text">O şifreyi şimdi girersen notlar bu cihazdaki şifrene taşınır. İstersen sonra kilitli bir nota dokunarak da yapabilirsin.</p>`,
    actions: [{ value: 'cancel', label: 'Sonra' }, { value: 'ok', label: 'Şifreyi gir', kind: 'primary' }],
  });
  if (!r) return;
  for (const kid of kids) if (!(await adoptForeign(kid))) break;
  render();
}

/* Lock: the open hidden note closes, the key leaves memory. Automatic after the app goes to the
   background (Hemen / 30 sn / 1 dk / 5 dk); while it is away the page is covered. */
function lockSecrets() {
  clearTimeout(sec.lockTimer);
  if (state.editing?.secret) {
    const fromApp = state.openedFromApp;
    closeEditor(); // starts its last save with the key still in hand
    if (fromApp) history.back(); else location.replace(`#/${state.view}`);
  }
  dropKey();
}
const veilEl = $('#veil');
function veilOn() { if (sec.key || state.editing?.secret) { veilEl.hidden = false; document.body.classList.add('veiled'); } }
function veilOff() { veilEl.hidden = true; document.body.classList.remove('veiled'); }
function onHideLock() {
  sec.hiddenAt = Date.now();
  clearTimeout(sec.lockTimer);
  if (!sec.key && !state.editing?.secret) return;
  const after = state.prefs.secretAfter || 0;
  if (!after) lockSecrets(); else sec.lockTimer = setTimeout(lockSecrets, after * 1000);
}
function onShowLock() {
  clearTimeout(sec.lockTimer);
  // Timers sleep in the background, so the time away is checked again on return.
  const after = (state.prefs.secretAfter || 0) * 1000;
  if ((sec.key || state.editing?.secret) && sec.hiddenAt && Date.now() - sec.hiddenAt >= after) lockSecrets();
  sec.hiddenAt = 0;
  veilOff();
}

async function setupBio() {
  const support = await checkBio();
  if (support === 'no') { toast('Bu cihazda desteklenmiyor'); return; }
  const r = await askPassword({ kid: sec.meta.current, title: 'Parmak izi / yüz ile aç', text: 'Kurmak için önce gizli not şifreni gir.', action: 'Devam', extractable: true, allowForgot: false, allowBio: false });
  if (!r) return;
  const kid = sec.meta.current;
  const entry = sec.meta.keys[kid];
  let made = null;
  const res = await formDialog({
    title: 'Parmak izi / yüz ile aç',
    html: `<p class="dlg-text">Cihazının parmak izi ya da yüz doğrulaması, gizli not anahtarını açan ikinci bir sır üretir. Şifren yine geçerli kalır.</p>
      <p class="hint">Yalnızca bu cihazda çalışır. Şifreyi değiştirirsen yeniden kurman gerekir.</p>`,
    actions: [CANCEL, { value: 'ok', label: 'Doğrulamayı başlat', kind: 'primary', busy: 'Bekleniyor…' }],
    onSubmit: async () => {
      // Straight from the tap. First the credential, then (if it did not answer yet) one check.
      let out;
      try {
        if (!made) {
          const prf = crypto.getRandomValues(new Uint8Array(32));
          const cred = await navigator.credentials.create({ publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { name: 'TakJot', id: location.hostname },
            user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'TakJot gizli notlar', displayName: 'TakJot gizli notlar' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
            timeout: 60000, attestation: 'none',
            extensions: { prf: { eval: { first: prf } } },
          } });
          const ext = cred?.getClientExtensionResults?.()?.prf;
          made = { credId: toB64(new Uint8Array(cred.rawId)), prf: toB64(prf) };
          if (!ext?.enabled && !ext?.results?.first) { forgetCredential(made.credId); bioSupport = 'no'; return { unsupported: true }; }
          out = ext.results?.first;
          if (!out) return { error: 'Bir kez daha doğrula: düğmeye yeniden dokun.' };
        } else {
          out = prfOut(await bioGet(made.credId, made.prf));
          if (!out) { forgetCredential(made.credId); bioSupport = 'no'; return { unsupported: true }; }
        }
      } catch (e) {
        return { error: e?.name === 'NotAllowedError' ? 'Doğrulama yapılmadı. Hazır olduğunda yeniden dene.' : 'Bu cihazda kurulamadı.' };
      }
      const box = await wrapWithSecret(r.key, new Uint8Array(out), entry);
      const meta = { ...sec.meta, bio: { kid, ...made, ...box } };
      await dbWrite([], meta);
      sec.meta = meta;
      bioSupport = 'yes';
      return { ok: true };
    },
  });
  if (res?.unsupported) {
    await formDialog({
      title: 'Bu cihazda desteklenmiyor',
      html: '<p class="dlg-text">Bu cihaz parmak izi ya da yüz doğrulamasından şifreleme anahtarı üretemiyor (WebAuthn PRF yok). Sadece ekranda sorup kilidi açmak güvenlik sağlamadığı için bu seçenek kapalı kalır. Gizli notları şifrenle açarsın.</p>',
      actions: [{ value: 'cancel', label: 'Tamam', kind: 'primary' }],
    });
  } else if (res?.ok) toast('Parmak izi / yüz ile açma kuruldu');
}
async function disableBio() {
  const m = sec.meta;
  if (!m?.bio) return;
  const meta = { ...m, bio: null };
  try { await dbWrite([], meta); } catch { toast('Ayar kaydedilemedi. Tekrar dene.'); return; }
  forgetCredential(m.bio.credId);
  sec.meta = meta;
  toast('Parmak izi / yüz ile açma kapatıldı');
}

async function secretSettings() {
  const support = await checkBio();
  const m = sec.meta;
  const hasCur = !!m?.current;
  const bioOn = !!m?.bio && m.bio.kid === m.current;
  const count = state.notes.filter(isHidden).length;
  showSheet('Gizli notlar', [
    sec.key && { icon: 'lock', label: 'Şimdi kilitle', run: () => { lockSecrets(); toast('Gizli notlar kilitlendi'); } },
    { icon: 'timer', label: 'Otomatik kilit', sub: state.prefs.secretAfter ? `${LOCK_AFTER[state.prefs.secretAfter] ?? 'Hemen'} sonra` : 'Hemen (arka plana geçince)', run: () => setTimeout(lockAfterMenu, 0) },
    hasCur && { icon: 'key', label: 'Şifreyi değiştir', run: changeSecretPassword },
    hasCur && (support === 'no' && !bioOn
      ? { icon: 'finger', label: 'Parmak izi / yüz ile aç', sub: 'Bu cihazda desteklenmiyor', disabled: true, run: () => {} }
      : { icon: 'finger', label: 'Parmak izi / yüz ile aç', toggle: bioOn, sub: bioOn ? 'Açık · şifre de geçerli' : 'Kapalı', run: () => (bioOn ? disableBio() : setupBio()) }),
    { icon: 'trash', label: 'Şifremi unuttum', sub: 'Yalnızca gizli notlar silinir', danger: true, run: forgotSecret },
  ], { info: `${icon('lock')}<span><small>Gizli notlar</small><b>${count} not · ${sec.key ? 'açık' : 'kilitli'}</b></span>` });
}
function lockAfterMenu() {
  showSheet('Otomatik kilit', Object.entries(LOCK_AFTER).map(([k, label]) => ({
    icon: 'timer', label: k === '0' ? 'Hemen (arka plana geçince)' : `${label} sonra`, checked: (state.prefs.secretAfter || 0) === Number(k),
    run: () => { state.prefs.secretAfter = Number(k); savePrefs(); },
  })));
}

/* ---------- Theme ---------- */
function applyTheme() {
  const t = state.prefs.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  syncStatusBar();
}
// The status bar takes the colour at the top of the screen: the page background,
// or the open note's colour while the editor covers everything.
function syncStatusBar() {
  const token = state.editing ? `--n-${state.editing.color}` : '--bg';
  const color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (color) document.querySelector('meta[name="theme-color"]').content = color;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

/* ---------- Install ---------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('TakJot ana ekrana eklendi'); });

function mainMenu() {
  const p = state.prefs;
  const c = p.cloud;
  const waiting = autoState() === 'pending';
  showSheet('Görünüm ve yedek', [
    { icon: p.layout === 'grid' ? 'rows' : 'grid', label: p.layout === 'grid' ? 'Liste görünümüne geç' : 'Izgara görünümüne geç', run: () => { p.layout = p.layout === 'grid' ? 'rows' : 'grid'; savePrefs(); render(); } },
    { icon: 'sort', label: `Sıralama: ${SORTS[p.sort]}`, run: () => setTimeout(sortMenu, 0) },
    { icon: 'theme', label: `Tema: ${THEMES[p.theme]}`, run: () => setTimeout(themeMenu, 0) },
    {
      icon: 'cloud-up', label: 'Buluta kaydet', run: cloudSave, dot: waiting,
      sub: waiting ? 'Yedek bekliyor' : c.lastBackupAt ? `Son yedek: ${fullWhen(c.lastBackupAt)}` : 'Henüz yedek yok',
    },
    { icon: 'cloud-down', label: 'Buluttan geri yükle', run: cloudRestore },
    { icon: 'cloud', label: 'Bulut ayarları', sub: c.connected ? (c.email || 'Google hesabı bağlı') : 'Bağlı değil', run: () => setTimeout(cloudSettings, 0) },
    (sec.meta || state.notes.some(isHidden)) && {
      icon: sec.key ? 'unlock' : 'lock', label: 'Gizli notlar',
      sub: sec.key ? `Açık · ${lockAfterLabel()}` : 'Kilitli', run: () => setTimeout(secretSettings, 0),
    },
    sec.key && { icon: 'lock', label: 'Gizli notları şimdi kilitle', run: () => { lockSecrets(); toast('Gizli notlar kilitlendi'); } },
    { icon: 'download', label: 'Yedeği dosya olarak indir', run: exportBackup },
    { icon: 'upload', label: 'Dosyadan geri yükle', run: () => $('#import-file').click() },
    installPrompt && {
      icon: 'install', label: 'Uygulamayı ana ekrana ekle',
      run: async () => { const ev = installPrompt; installPrompt = null; await ev.prompt(); },
    },
    { icon: 'help', label: 'Tanıtımı tekrar göster', run: () => showOnboarding() },
    { icon: 'shield', label: 'Gizlilik ve KVKK', run: () => { location.href = 'kvkk.html'; } },
  ], { brand: true });
}

/* ---------- Onboarding: four short screens, first run only ---------- */
const ob = { dlg: $('#dlg-onboard'), track: $('#ob-track'), next: $('#ob-next'), dots: [...$('#ob-dots').children], idx: 0 };
const obSlides = [...ob.track.children];
function obSet(i) {
  ob.idx = i;
  obSlides.forEach((s, k) => { s.inert = k !== i; });
  ob.dots.forEach((d, k) => d.classList.toggle('on', k === i));
  const last = i === obSlides.length - 1;
  ob.next.textContent = last ? 'Başla' : 'İleri';
  $('#ob-status').textContent = `Ekran ${i + 1} / ${obSlides.length}: ${obSlides[i].querySelector('.ob-title').textContent}`;
}
function obGo(i) {
  const k = Math.max(0, Math.min(obSlides.length - 1, i));
  ob.track.scrollTo({ left: k * ob.track.clientWidth, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  obSet(k);
}
function showOnboarding() {
  if (ob.dlg.open) return;
  ob.dlg.showModal();
  ob.track.scrollLeft = 0;
  obSet(0);
  ob.next.focus();
}
function finishOnboarding() {
  state.prefs.onboardingDone = true;
  savePrefs();
  if (ob.dlg.open) ob.dlg.close();
}
ob.next.addEventListener('click', () => {
  if (ob.idx >= obSlides.length - 1) finishOnboarding(); else obGo(ob.idx + 1);
});
$('#ob-skip').addEventListener('click', finishOnboarding);
ob.dlg.addEventListener('cancel', e => { e.preventDefault(); finishOnboarding(); });
// A swipe moves the track; the current screen follows where it settles.
let obScrollTimer = 0;
ob.track.addEventListener('scroll', () => {
  clearTimeout(obScrollTimer);
  obScrollTimer = setTimeout(() => {
    const i = Math.round(ob.track.scrollLeft / Math.max(1, ob.track.clientWidth));
    if (i !== ob.idx) obSet(i);
  }, 80);
}, { passive: true });
ob.dlg.addEventListener('keydown', e => {
  if (e.target.closest('a')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); obGo(ob.idx + 1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); obGo(ob.idx - 1); }
});
// Keep the current screen in place when the window is resized or rotated.
window.addEventListener('resize', () => { if (ob.dlg.open) ob.track.scrollLeft = ob.idx * ob.track.clientWidth; });
function sortMenu() {
  showSheet('Sırala', Object.entries(SORTS).map(([k, label]) => ({
    icon: 'sort', label, checked: state.prefs.sort === k,
    run: () => { state.prefs.sort = k; savePrefs(); render(); },
  })));
}
function themeMenu() {
  showSheet('Tema', Object.entries(THEMES).map(([k, label]) => ({
    icon: 'theme', label, checked: state.prefs.theme === k,
    run: () => { state.prefs.theme = k; savePrefs(); applyTheme(); },
  })));
}

/* ---------- Events: chrome ---------- */
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => goView(t.dataset.view)));
$('#fab').addEventListener('click', newNote);
$('#menu-btn').addEventListener('click', mainMenu);

function openSearch() { $('#search-input').focus(); }
function closeSearch() {
  $('#search-input').value = '';
  $('#search-close').hidden = true;
  state.query = '';
  render();
}
$('#search-close').addEventListener('click', () => { closeSearch(); $('#search-input').focus(); });
$('#search-input').addEventListener('input', e => {
  state.query = e.target.value;
  $('#search-close').hidden = !state.query;
  renderList($('#view'));
});
$('#search-input').addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); });

$('#kinds').addEventListener('click', e => {
  const k = e.target.closest('[data-kind]')?.dataset.kind;
  if (!k || k === state.kind) return;
  state.kind = k;
  render();
});
$('#palette').addEventListener('click', e => {
  const c = e.target.closest('[data-color]')?.dataset.color;
  if (!c) return;
  state.filterColor = state.filterColor === c ? null : c;
  render();
});

$('#view').addEventListener('click', async e => {
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open) {
    const n = findNote(open);
    if (!n) return;
    if (n.deletedAt) trashMenu(n); else if (isHidden(n)) openHidden(n); else openNote(n.id);
    return;
  }
  const day = e.target.closest('[data-day]')?.dataset.day;
  if (day) { state.calDay = day; render(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'new') newNote();
  if (act === 'clear-filter') { state.filterColor = null; render(); }
  if (act === 'clear-search') closeSearch();
  if (act === 'clear-kind') { state.kind = 'all'; render(); }
  if (act === 'cal-prev' || act === 'cal-next') {
    const m = state.calMonth;
    state.calMonth = new Date(m.getFullYear(), m.getMonth() + (act === 'cal-next' ? 1 : -1), 1);
    render();
  }
  if (act === 'cal-today') { state.calMonth = startOfMonth(new Date()); state.calDay = dayKey(Date.now()); render(); }
  if (act === 'empty-trash') {
    const trashed = scopeNotes('trash');
    const ok = await confirmDialog({
      title: 'Çöp kutusu boşaltılsın mı?',
      body: `${trashed.length} not kalıcı olarak silinecek. Bu işlem geri alınamaz.`,
      ok: `${trashed.length} notu kalıcı olarak sil`,
    });
    if (!ok) return;
    // Hidden notes among them: every password they were locked with is asked once.
    for (const kid of new Set(trashed.filter(isHidden).map(n => n.enc.kid))) {
      if (!(await confirmSecret({ kid, title: 'Gizli notlar da silinecek', text: 'Çöp kutusunda gizli not var. Onaylamak için gizli not şifreni gir.', action: 'Kalıcı olarak sil', danger: true }))) return;
    }
    for (const n of trashed) await destroyNote(n.id);
    render();
    toast('Çöp kutusu boşaltıldı');
  }
});

/* ---------- Manual order: hold (touch) or drag (mouse) a note to move it ---------- */
const LIFT_DELAY = 350;   // touch: hold this long before the note lifts
const SLOP_TOUCH = 8;     // touch: moving further than this before the lift means "scroll"
const SLOP_MOUSE = 5;     // mouse: the drag starts once the pointer travels this far
const SETTLE_MS = 200;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let press = null;         // a pointer down on a note that has not lifted it yet
let drag = null;          // the note being moved
let swallowClick = false; // the click that ends a drag must not open the note

// Untransformed page position, so in-flight animations never skew the maths.
function layoutPos(el) {
  let x = 0; let y = 0;
  for (let n = el; n; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}
const isFiltered = () => !!(state.query.trim() || state.filterColor || state.kind !== 'all');

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}
function tryLift(p, cx, cy) {
  cancelPress();
  if (!p.card.isConnected || state.view !== 'notes') return;
  swallowClick = true;
  if (isFiltered()) { toast('Notları sıralamak için önce aramayı ve süzgeçleri kapat.'); return; }
  const card = p.card;
  const pos = layoutPos(card);
  drag = {
    card, box: card.parentElement, pointerId: p.id,
    grabX: cx + scrollX - pos.x, grabY: cy + scrollY - pos.y,
    cx, cy, raf: 0, renderPending: false, switched: false, prevSort: state.prefs.sort, overBin: false,
  };
  // Starting a drag under another sort switches to manual; what is on screen
  // now becomes the starting order (saved on drop).
  if (state.prefs.sort !== 'manual') { state.prefs.sort = 'manual'; savePrefs(); drag.switched = true; }
  card.classList.add('lifted');
  document.body.classList.add('dragging-note');
  announce('Silmek için kovaya bırak');
  if (p.type !== 'mouse') navigator.vibrate?.(8);
  drag.raf = requestAnimationFrame(autoScroll);
}

/* The bin at the bottom of the screen: over it, the note is not reordered; dropped on it, it goes to the trash. */
const bin = $('#drop-bin');
function announce(msg) {
  const el = $('#sr-live');
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 30);
}
// Where the bin's top edge is once it has slid in (not where it is mid-slide).
const binTop = () => innerHeight - bin.offsetHeight;
function updateBin(d) {
  const over = d.cy >= binTop();
  if (over === d.overBin) return;
  d.overBin = over;
  bin.classList.toggle('over', over);
  d.card.classList.toggle('to-bin', over);
  if (over) { navigator.vibrate?.(10); announce('Bırakırsan not çöp kutusuna gider'); }
}

// Which slot the held note's centre points at, or null when it should stay put.
function findSlot(d, midX, midY) {
  const sibs = [...d.box.children];
  const cur = sibs.indexOf(d.card);
  if (d.box.classList.contains('rows')) {
    // One column: the slot is the number of other notes whose middle is above ours.
    // Moving the note shifts those middles away from it, so this never flip-flops.
    const idx = sibs.filter(s => s !== d.card).filter(s => { const p = layoutPos(s); return p.y + p.h / 2 < midY; }).length;
    return idx === cur ? null : idx;
  }
  let best = null; let bestD = Infinity;
  sibs.forEach(s => {
    const p = layoutPos(s);
    const dist = Math.hypot(p.x + p.w / 2 - midX, p.y + p.h / 2 - midY);
    if (dist < bestD) { bestD = dist; best = s; }
  });
  return !best || best === d.card ? null : sibs.indexOf(best);
}

// Move the held note to slot idx and glide the others into their new places (FLIP).
function reorder(d, idx) {
  const sibs = [...d.box.children].filter(c => c !== d.card);
  const before = sibs.map(s => s.getBoundingClientRect());
  d.box.insertBefore(d.card, sibs[idx] ?? null);
  if (reduceMotion.matches) return;
  sibs.forEach(s => s.getAnimations().forEach(a => { if (a.id === 'reflow') a.cancel(); }));
  const after = sibs.map(s => s.getBoundingClientRect());
  sibs.forEach((s, i) => {
    const dx = before[i].left - after[i].left;
    const dy = before[i].top - after[i].top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    s.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], { duration: SETTLE_MS, easing: EASE_OUT, id: 'reflow' });
  });
}

// Track phase: the note sits exactly under the finger, no easing.
function moveDrag() {
  const d = drag;
  const left = d.cx + scrollX - d.grabX;
  const top = d.cy + scrollY - d.grabY;
  let pos = layoutPos(d.card);
  updateBin(d);
  const idx = d.overBin ? null : findSlot(d, left + pos.w / 2, top + pos.h / 2);
  if (idx !== null) { reorder(d, idx); pos = layoutPos(d.card); }
  d.card.style.translate = `${left - pos.x}px ${top - pos.y}px`;
}

// Near the top or bottom edge, the page scrolls on its own, faster the closer you get.
function autoScroll() {
  const d = drag;
  if (!d) return;
  const edge = 72;
  // The bin covers the bottom of the screen while dragging; scrolling starts above it.
  const bottom = binTop();
  let v = 0;
  if (d.cy < edge) v = (d.cy - edge) / edge;
  else if (!d.overBin && d.cy > bottom - edge) v = (d.cy - (bottom - edge)) / edge;
  if (v) {
    const y0 = scrollY;
    window.scrollBy(0, Math.max(-1, Math.min(1, v)) * 16);
    if (scrollY !== y0) moveDrag();
  }
  d.raf = requestAnimationFrame(autoScroll);
}

async function endDrag() {
  const d = drag;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  bin.classList.remove('over');
  document.body.classList.remove('dragging-note');
  if (d.overBin) {
    // Into the bin: nothing is reordered and the sort stays what it was.
    drag = null;
    if (d.switched) { state.prefs.sort = d.prevSort; savePrefs(); }
    const n = state.notes.find(x => x.id === d.card.dataset.id);
    if (n && isHidden(n)) {
      // A hidden note goes to the trash only with its password.
      d.card.style.translate = '';
      d.card.classList.remove('lifted', 'to-bin');
      const ok = await confirmSecret({ kid: n.enc.kid, title: 'Gizli notu sil', text: 'Gizli not çöp kutusuna taşınacak. Onaylamak için gizli not şifreni gir.', action: 'Sil' });
      if (!ok) { render(); return; }
    } else if (!reduceMotion.matches) {
      const fade = d.card.animate([{ opacity: 1 }, { opacity: 0, scale: '.6' }], { duration: 160, easing: EASE_OUT, fill: 'forwards' });
      // Never wait on a throttled tab for longer than the animation should take.
      await Promise.race([fade.finished.catch(() => {}), new Promise(r => setTimeout(r, 220))]);
    }
    if (n) await moveToTrash(n, 'Çöp kutusuna taşındı');
    render();
    return;
  }
  const [tx = 0, ty = 0] = (d.card.style.translate || '').split(' ').map(parseFloat);
  d.card.style.translate = '';
  d.card.classList.remove('lifted');
  // Release phase: settle into the slot from wherever the finger let go.
  if (!reduceMotion.matches && (tx || ty)) {
    d.card.animate([{ translate: `${tx}px ${ty}px` }, { translate: '0px 0px' }], { duration: SETTLE_MS, easing: EASE_OUT });
  }
  drag = null;
  await saveManualOrder();
  if (d.switched) toast('Sıralama “Elle (sürükle)” olarak değişti');
  if (d.renderPending) render();
}

// The board as it now stands becomes the order. Only the position changes:
// updatedAt stays as it was.
async function saveManualOrder() {
  const changed = [];
  [...$('#view').querySelectorAll('.notes .card')].forEach((c, i) => {
    const n = state.notes.find(x => x.id === c.dataset.id);
    if (n && n.order !== i) { n.order = i; changed.push(n); }
  });
  if (!changed.length) return;
  try { await dbPutMany(changed); requestPersist(); scheduleAutoBackup(); }
  catch (err) { console.error(err?.name ?? 'order'); toast('Sıra kaydedilemedi. Depolama alanını kontrol edip tekrar dene.'); }
}

$('#view').addEventListener('pointerdown', e => {
  swallowClick = false;
  if (drag || press || !e.isPrimary || state.view !== 'notes') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const card = e.target.closest('.notes .card');
  if (!card) return;
  const p = { card, id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, timer: 0 };
  // Touch waits for a hold, so a swipe that starts on a note still scrolls the page.
  if (p.type !== 'mouse') p.timer = setTimeout(() => { if (press === p) tryLift(p, p.x, p.y); }, LIFT_DELAY);
  press = p;
});
window.addEventListener('pointermove', e => {
  if (drag) {
    if (e.pointerId !== drag.pointerId) return;
    drag.cx = e.clientX; drag.cy = e.clientY;
    moveDrag();
    return;
  }
  if (!press || e.pointerId !== press.id) return;
  const p = press;
  const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
  if (p.type !== 'mouse') { if (dist > SLOP_TOUCH) cancelPress(); return; }
  if (dist <= SLOP_MOUSE) return;
  // Grab where the button went down, then catch up to the pointer at once.
  tryLift(p, p.x, p.y);
  if (drag) { drag.cx = e.clientX; drag.cy = e.clientY; moveDrag(); }
});
function onPointerEnd(e) {
  if (drag && e.pointerId === drag.pointerId) endDrag();
  else if (press && e.pointerId === press.id) cancelPress();
  // Only the click that belongs to this gesture is swallowed; if none comes,
  // the next click (say, Enter on a note) must still work.
  if (swallowClick) setTimeout(() => { swallowClick = false; }, 400);
}
window.addEventListener('pointerup', onPointerEnd);
window.addEventListener('pointercancel', onPointerEnd);
// Once a note is lifted the finger moves the note, not the page.
document.addEventListener('touchmove', e => { if (drag && e.cancelable) e.preventDefault(); }, { passive: false });
$('#view').addEventListener('contextmenu', e => { if (drag || press) e.preventDefault(); });
$('#view').addEventListener('click', e => {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);

function trashMenu(n) {
  const hidden = isHidden(n);
  showSheet(noteLabel(n), [
    {
      icon: 'restore', label: 'Geri yükle', run: async () => {
        if (hidden && !(await confirmSecret({ kid: n.enc.kid, title: 'Gizli notu geri yükle', text: 'Gizli not çöp kutusundan çıkacak. Onaylamak için bu notun şifresini gir.', action: 'Geri yükle' }))) return;
        n = state.notes.find(x => x.id === n.id) ?? n;
        n.deletedAt = null; await saveNote(n, { touch: false }); render(); toast(n.archived ? 'Not arşive geri yüklendi' : 'Not geri yüklendi');
      },
    },
    {
      icon: 'trash', label: 'Kalıcı olarak sil', danger: true,
      run: async () => {
        const ok = hidden
          ? await confirmSecret({ kid: n.enc.kid, title: 'Kalıcı olarak sil', text: 'Gizli not kalıcı olarak silinecek. Bu işlem geri alınamaz. Onaylamak için bu notun şifresini gir.', action: 'Kalıcı olarak sil', danger: true })
          : await confirmDialog({ title: 'Not kalıcı olarak silinsin mi?', body: `“${noteLabel(n)}” silinecek. Bu işlem geri alınamaz.`, ok: 'Kalıcı olarak sil' });
        if (!ok) return;
        await destroyNote(n.id);
        render();
        toast('Not kalıcı olarak silindi');
      },
    },
  ]);
}

/* ---------- Events: editor ---------- */
$('#ed-back').addEventListener('click', leaveEditor);
ed.title.addEventListener('input', () => { state.editing.title = ed.title.value; scheduleSave(); });
ed.title.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const n = state.editing;
  if (n.type === 'text') ed.body.focus();
  else if (n.items.some(i => !i.done)) focusItem(n.items.find(i => !i.done).id);
  else addItemAfter(null);
});
ed.body.addEventListener('input', () => { state.editing.body = ed.body.value; autosize(ed.body); scheduleSave(); });
ed.pin.addEventListener('click', () => {
  const n = state.editing;
  n.pinned = !n.pinned;
  if (n.pinned) n.archived = false;
  renderEditor();
  scheduleSave();
});
$('#ed-remind').addEventListener('click', openReminderDialog);
ed.chip.addEventListener('click', openReminderDialog);
ed.archive.addEventListener('click', async () => {
  const n = state.editing;
  clearTimeout(saveTimer); saveTimer = null;
  if (state.pending?.id === n.id && isEmpty(n)) { leaveEditor(); return; }
  await setArchived(n, !n.archived);
  leaveEditor();
});
$('#ed-more').addEventListener('click', editorMenu);
ed.type.addEventListener('click', () => {
  if (!state.editing) return;
  convertType();
  const n = state.editing;
  requestAnimationFrame(() => {
    if (n.type === 'list') {
      const open = n.items.filter(i => !i.done);
      if (open.length) focusItem(open[open.length - 1].id);
    } else {
      ed.body.focus();
      ed.body.setSelectionRange(ed.body.value.length, ed.body.value.length);
    }
  });
});
ed.colors.addEventListener('click', e => {
  const c = e.target.closest('[data-swatch]')?.dataset.swatch;
  if (!c) return;
  state.editing.color = c;
  state.prefs.lastColor = c; savePrefs();
  renderEditor();
  ed.colors.querySelector(`[data-swatch="${c}"]`)?.focus();
  scheduleSave();
});
ed.colors.addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const i = COLOR_IDS.indexOf(state.editing.color);
  const next = COLOR_IDS[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + COLOR_IDS.length) % COLOR_IDS.length];
  ed.colors.querySelector(`[data-swatch="${next}"]`)?.click();
});

ed.list.addEventListener('input', e => {
  const ta = e.target.closest('.item-text');
  if (!ta) return;
  const item = state.editing.items.find(i => i.id === ta.closest('[data-item]').dataset.item);
  if (!item) return;
  if (ta.value.includes('\n')) {
    // Pasted several lines: split them into separate items.
    const [first, ...rest] = ta.value.split('\n');
    item.text = first;
    let after = item.id;
    const n = state.editing;
    rest.filter(s => s.trim()).forEach(text => {
      const it = { id: uid(), text, done: false };
      n.items.splice(n.items.findIndex(i => i.id === after) + 1, 0, it);
      after = it.id;
    });
    renderItems();
    focusItem(after);
  } else {
    item.text = ta.value;
    autosize(ta);
  }
  scheduleSave();
});
ed.list.addEventListener('keydown', e => {
  const ta = e.target.closest('.item-text');
  if (!ta) return;
  const id = ta.closest('[data-item]').dataset.item;
  const n = state.editing;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const pos = ta.selectionStart;
    const item = n.items.find(i => i.id === id);
    const tail = ta.value.slice(pos);
    item.text = ta.value.slice(0, pos);
    addItemAfter(id, tail);
    const active = document.activeElement;
    if (active?.classList.contains('item-text')) active.setSelectionRange(0, 0);
  } else if (e.key === 'Backspace' && ta.value === '' && n.items.length > 1) {
    e.preventDefault();
    const visible = [...ed.list.querySelectorAll('[data-item]')].map(li => li.dataset.item);
    const prev = visible[visible.indexOf(id) - 1];
    n.items = n.items.filter(i => i.id !== id);
    renderItems();
    if (prev) focusItem(prev);
    scheduleSave();
  }
});
ed.list.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add-item') { addItemAfter(null); return; }
  if (act === 'toggle-done') { state.doneOpen = !state.doneOpen; renderItems(); return; }
  const li = e.target.closest('[data-item]');
  if (!li) return;
  const n = state.editing;
  const item = n.items.find(i => i.id === li.dataset.item);
  if (!item) return;
  if (e.target.closest('.check')) {
    item.done = !item.done;
    // Move to the end of its new group so order stays predictable.
    n.items = [...n.items.filter(i => i !== item), item];
    n.items = [...n.items.filter(i => !i.done), ...n.items.filter(i => i.done)];
    renderItems();
    scheduleSave();
  } else if (e.target.closest('.item-del')) {
    const visible = [...ed.list.querySelectorAll('[data-item]')].map(x => x.dataset.item);
    const prev = visible[visible.indexOf(item.id) - 1];
    n.items = n.items.filter(i => i !== item);
    renderItems();
    if (prev) focusItem(prev);
    scheduleSave();
  }
});

/* ---------- Keyboard shortcuts (desktop) ---------- */
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = e.target.closest?.('input, textarea, [contenteditable]');
  if (!$('#editor').hidden) {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) leaveEditor();
    return;
  }
  if (typing || document.querySelector('dialog[open]')) return;
  if (e.key === 'n') { e.preventDefault(); if (!$('#fab').hidden) newNote(); }
  if (e.key === '/' && state.view !== 'calendar') { e.preventDefault(); openSearch(); }
});

/* ---------- Lifecycle ---------- */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { veilOn(); commit(); onHideLock(); }
  else { onShowLock(); scheduleReminders(); if (!state.editing) render(); scheduleAutoBackup(); }
});
window.addEventListener('online', () => scheduleAutoBackup());
window.addEventListener('pagehide', () => { commit(); if (sec.key || state.editing?.secret) { veilOn(); lockSecrets(); } });
// Back from the browser's page cache: the veil goes, the lock stays.
window.addEventListener('pageshow', e => { if (e.persisted) veilOff(); });

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'open' && e.data.id) openNote(e.data.id);
});

async function init() {
  applyTheme();
  try {
    state.notes = (await dbAll()).map(sanitize).filter(Boolean);
    sec.meta = sanitizeVault(await dbGetVault());
  } catch (err) {
    console.error(err?.name ?? 'load');
    toast('Notlar yüklenemedi. Tarayıcı depolamaya izin vermiyor olabilir; gizli sekmede açtıysan normal sekmede dene.');
  }
  // Empty the trash of notes older than the retention window.
  const cutoff = Date.now() - TRASH_DAYS * DAY;
  for (const n of state.notes.filter(x => x.deletedAt && x.deletedAt < cutoff)) {
    await destroyNote(n.id).catch(() => {});
  }
  if (!location.hash) location.replace('#/notes');
  window.addEventListener('hashchange', onRoute);
  const r = parseRoute();
  if (r.note) { render(); onRoute(); } else onRoute();
  scheduleReminders();
  refreshPendingMark();
  setInterval(maybeAutoBackup, AUTO_CHECK_MS);

  // First run only. Someone who already has notes or settings has used the app: no tour.
  if (!state.prefs.onboardingDone) {
    if (state.notes.length || HAD_PREFS) { state.prefs.onboardingDone = true; savePrefs(); }
    else showOnboarding();
  }

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker kaydedilemedi', err));
  }
}
init();
