// Palet: colour notes, checklists and reminders. Data stays on the device (IndexedDB).

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
};
const KINDS = { all: 'Hepsi', text: 'Notlar', list: 'Listeler', reminder: 'Hatırlatıcılı' };
const TAPES = ['#F4A6BD', '#F6B26B', '#8FD9C0', '#BBA7EE', '#F3D46B'];
const THEMES = { system: 'Sistem ayarı', light: 'Açık', dark: 'Koyu' };
const TRASH_DAYS = 30;
const DAY = 86400000;

/* ---------- Preferences (per device convenience) ---------- */
const PREF_KEY = 'palet.prefs';
const DEFAULT_PREFS = { layout: 'grid', sort: 'updated', theme: 'system', lastColor: 'yellow' };
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs)); } catch { /* storage unavailable */ }
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'palet';
const STORE = 'notes';
let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = note => tx('readwrite', s => s.put(note));
const dbDelete = id => tx('readwrite', s => s.delete(id));
const dbPutMany = notes => tx('readwrite', s => { notes.forEach(n => s.put(n)); });

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
const isEmpty = n => !n.title.trim() && !n.body.trim() && !n.items.some(i => i.text.trim());

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const num = v => (Number.isFinite(v) ? v : null);
  const t = Date.now();
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
  };
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
  doneOpen: true,
  calMonth: startOfMonth(new Date()),
  calDay: dayKey(Date.now()),
  prefs: loadPrefs(),
};
const findNote = id => state.notes.find(n => n.id === id) ?? (state.pending?.id === id ? state.pending : null);

async function saveNote(n, { touch = true } = {}) {
  if (touch) n.updatedAt = Date.now();
  const i = state.notes.findIndex(x => x.id === n.id);
  if (i < 0) state.notes.push(n); else state.notes[i] = n;
  if (state.pending?.id === n.id) state.pending = null;
  try { await dbPut(n); } catch (err) { console.error(err); toast('Not kaydedilemedi. Depolama alanını kontrol edip tekrar dene.'); }
  requestPersist();
}
async function destroyNote(id) {
  state.notes = state.notes.filter(n => n.id !== id);
  await dbDelete(id);
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
function showSheet(title, items) {
  const dlg = $('#dlg-sheet');
  $('#sheet-title').textContent = title;
  const box = $('#sheet-items');
  box.innerHTML = '';
  items.filter(Boolean).forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sheet-item${it.danger ? ' danger' : ''}`;
    b.innerHTML = `${icon(it.icon)}<span>${esc(it.label)}</span>${it.checked ? icon('check', 'tick') : ''}`;
    if (it.checked !== undefined) { b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(!!it.checked)); }
    b.addEventListener('click', () => { dlg.close(); it.run(); });
    box.appendChild(b);
  });
  dlg.showModal();
  box.querySelector('button')?.focus();
}

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
  return k === 'all' || (k === 'reminder' ? !!n.reminderAt : n.type === k);
}

function cardHtml(n) {
  let preview = '';
  if (n.type === 'list') {
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
  return `<article class="card${curl}" data-hold="${hold}" style="--c:var(--n-${n.color});--tilt:${tilt}deg">
    <button class="card-hit" type="button" data-open="${esc(n.id)}" aria-label="${esc(noteLabel(n))}, ${colorName(n.color)} not${n.pinned ? ', sabitlenmiş' : ''}${n.type === 'list' ? ', liste' : ''}"></button>
    ${holder}
    ${n.title.trim() ? `<h3 class="card-title">${esc(n.title)}</h3>` : ''}
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
  if (state.kind !== 'all' && scoped.length && !state.filterColor) {
    return `<div class="empty">${emptyArt(['green'])}<h2>Burada ${KINDS[state.kind].toLocaleLowerCase('tr')} not yok</h2><p>${state.kind === 'reminder' ? 'Bir notta zil simgesine dokunarak hatırlatıcı kurabilirsin.' : state.kind === 'list' ? 'Bir notu listeye çevirmek için notun menüsünü kullan.' : 'Bu bölümdeki notların hepsi liste.'}</p><button class="btn outline" type="button" data-act="clear-kind">Hepsini göster</button></div>`;
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
  kinds.innerHTML = Object.entries(KINDS).map(([k, label]) =>
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
  $('#view-title').textContent = VIEWS[state.view];
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  const isCal = state.view === 'calendar';
  $('#search-row').hidden = isCal;
  $('#fab').hidden = state.view === 'trash' || state.view === 'archive';
  renderPalette();
  const main = $('#view');
  if (isCal) renderCalendar(main); else renderList(main);
}

/* ---------- Editor ---------- */
const ed = {
  root: $('#editor'), title: $('#ed-title'), body: $('#ed-body'), list: $('#ed-list'),
  chip: $('#ed-chip'), stamp: $('#ed-stamp'), colors: $('#ed-colors'),
  pin: $('#ed-pin'), archive: $('#ed-archive'),
};
let saveTimer = null;

function newNote() {
  const extra = { color: state.filterColor ?? state.prefs.lastColor ?? 'yellow' };
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
  const n = findNote(id);
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
  syncStatusBar();
  ed.pin.setAttribute('aria-pressed', String(n.pinned));
  ed.pin.setAttribute('aria-label', n.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle');
  ed.pin.innerHTML = icon(n.pinned ? 'pin-fill' : 'pin');
  ed.archive.setAttribute('aria-label', n.archived ? 'Arşivden çıkar' : 'Arşivle');
  ed.archive.innerHTML = icon(n.archived ? 'unarchive' : 'archive');
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
  ed.stamp.textContent = state.pending?.id === n.id ? 'Yeni not' : `Düzenlendi: ${whenLabel(n.updatedAt)}`;
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

async function moveToTrash(n) {
  const before = { deletedAt: n.deletedAt, pinned: n.pinned };
  n.deletedAt = Date.now();
  n.pinned = false;
  await saveNote(n, { touch: false });
  toast('Not çöp kutusuna taşındı', {
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
  showSheet('Not', [
    { icon: n.type === 'text' ? 'checklist' : 'text', label: n.type === 'text' ? 'Yapılacaklar listesine dönüştür' : 'Düz metne dönüştür', run: convertType },
    { icon: 'share', label: 'Paylaş', run: () => shareNote(n) },
    {
      icon: 'copy', label: 'Kopyasını oluştur', run: async () => {
        if (isEmpty(n)) { toast('Boş not kopyalanamaz'); return; }
        await commit();
        const t = Date.now();
        const copy = { ...structuredClone(n), id: uid(), title: n.title ? `${n.title} (kopya)` : '', pinned: false, reminderAt: null, reminderFired: false, createdAt: t, updatedAt: t, items: n.items.map(i => ({ ...i, id: uid() })) };
        await saveNote(copy);
        state.openedFromApp = true;
        location.replace(`#/note/${encodeURIComponent(copy.id)}`);
        toast('Kopya oluşturuldu');
      },
    },
    { icon: 'trash', label: 'Sil', danger: true, run: async () => { await commitOrDiscard(n); leaveEditor(); } },
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
  n.reminderFired = true;
  await saveNote(n, { touch: false });
  const title = noteLabel(n);
  const body = n.title ? noteText(n).slice(0, 140) : `Hatırlatıcı: ${whenLabel(n.reminderAt)}`;
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
  if (!('Notification' in window)) return 'Bu tarayıcı bildirim göstermiyor. Hatırlatıcı, Palet açıkken ekranda görünür.';
  if (Notification.permission === 'denied') return 'Bildirim izni kapalı. Hatırlatıcı, Palet açıkken ekranda görünür. İzni tarayıcının site ayarlarından açabilirsin.';
  return 'Bildirim, Palet açıkken gelir. Kapalıyken kaçan hatırlatıcılar uygulamayı açtığında gösterilir.';
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
function exportBackup() {
  const data = { app: 'palet', version: 1, exportedAt: new Date().toISOString(), notes: state.notes };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `palet-yedek-${dayKey(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`${state.notes.length} not yedek dosyasına yazıldı`);
}
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const raw = Array.isArray(data) ? data : data?.notes;
    if (!Array.isArray(raw)) throw new Error('format');
    const incoming = raw.map(sanitize).filter(Boolean);
    let added = 0; let updated = 0;
    const toWrite = [];
    incoming.forEach(n => {
      const cur = state.notes.find(x => x.id === n.id);
      if (!cur) { state.notes.push(n); toWrite.push(n); added++; }
      else if (n.updatedAt > cur.updatedAt) { Object.assign(cur, n); toWrite.push(cur); updated++; }
    });
    await dbPutMany(toWrite);
    render();
    scheduleReminders();
    toast(added || updated ? `${added} not eklendi, ${updated} not güncellendi` : 'Yedekteki notların hepsi zaten burada');
  } catch {
    toast('Bu dosya okunamadı. Palet’ten indirilen bir .json yedek dosyası seç.');
  }
});

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
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Palet ana ekrana eklendi'); });

function mainMenu() {
  const p = state.prefs;
  showSheet('Görünüm ve yedek', [
    { icon: p.layout === 'grid' ? 'rows' : 'grid', label: p.layout === 'grid' ? 'Liste görünümüne geç' : 'Izgara görünümüne geç', run: () => { p.layout = p.layout === 'grid' ? 'rows' : 'grid'; savePrefs(); render(); } },
    { icon: 'sort', label: `Sıralama: ${SORTS[p.sort]}`, run: () => setTimeout(sortMenu, 0) },
    { icon: 'theme', label: `Tema: ${THEMES[p.theme]}`, run: () => setTimeout(themeMenu, 0) },
    { icon: 'download', label: 'Yedeği indir', run: exportBackup },
    { icon: 'upload', label: 'Yedekten geri yükle', run: () => $('#import-file').click() },
    installPrompt && {
      icon: 'install', label: 'Uygulamayı ana ekrana ekle',
      run: async () => { const ev = installPrompt; installPrompt = null; await ev.prompt(); },
    },
  ]);
}
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
    if (n.deletedAt) trashMenu(n); else openNote(n.id);
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
    for (const n of trashed) await destroyNote(n.id);
    render();
    toast('Çöp kutusu boşaltıldı');
  }
});

function trashMenu(n) {
  showSheet(noteLabel(n), [
    { icon: 'restore', label: 'Geri yükle', run: async () => { n.deletedAt = null; await saveNote(n, { touch: false }); render(); toast(n.archived ? 'Not arşive geri yüklendi' : 'Not geri yüklendi'); } },
    {
      icon: 'trash', label: 'Kalıcı olarak sil', danger: true,
      run: async () => {
        const ok = await confirmDialog({ title: 'Not kalıcı olarak silinsin mi?', body: `“${noteLabel(n)}” silinecek. Bu işlem geri alınamaz.`, ok: 'Kalıcı olarak sil' });
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
  if (document.visibilityState === 'hidden') commit();
  else { scheduleReminders(); if (!state.editing) render(); }
});
window.addEventListener('pagehide', () => commit());

navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'open' && e.data.id) openNote(e.data.id);
});

async function init() {
  applyTheme();
  try {
    state.notes = (await dbAll()).map(sanitize).filter(Boolean);
  } catch (err) {
    console.error(err);
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

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker kaydedilemedi', err));
  }
}
init();
