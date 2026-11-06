// Almacenamiento local (IndexedDB) + sincronización opcional con el servidor.
import { apiUrl } from './native.js';

const DB_NAME = 'pedal-ba';
const STORES = ['activities', 'routes', 'kv'];
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}

export const getAll = (store) => tx(store, 'readonly', s => s.getAll());
export const get = (store, id) => tx(store, 'readonly', s => s.get(id));
export const put = (store, obj) => tx(store, 'readwrite', s => s.put(obj));
export const putMany = (store, arr) => tx(store, 'readwrite', s => { arr.forEach(o => s.put(o)); });

// ---------- ajustes ----------
export async function getSetting(key, def) {
  const r = await get('kv', key);
  return r ? r.value : def;
}
export const setSetting = (key, value) => put('kv', { id: key, value });

// ---------- actividades y rutas propias (con borrado lógico para sync) ----------
export async function listActivities() {
  const all = await getAll('activities');
  return all.filter(a => !a.deleted).sort((a, b) => b.startedAt - a.startedAt);
}
export async function saveActivity(a) {
  a.updatedAt = Date.now();
  await put('activities', a);
  scheduleSync();
  return a;
}
export async function deleteActivity(id) {
  const a = await get('activities', id);
  if (!a) return;
  await put('activities', { id, deleted: true, updatedAt: Date.now(), startedAt: a.startedAt });
  scheduleSync();
}

export async function listMyRoutes() {
  return (await getAll('routes')).filter(r => !r.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function saveMyRoute(r) { r.updatedAt = Date.now(); await put('routes', r); scheduleSync(); return r; }
export async function deleteMyRoute(id) { await put('routes', { id, deleted: true, updatedAt: Date.now() }); scheduleSync(); }

// ---------- sincronización ----------
let syncTimer;
const listeners = new Set();
export const onSync = (fn) => listeners.add(fn);

export function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch(() => {}), delay);
}

export async function sync({ full = false } = {}) {
  const token = await getSetting('syncToken', '');
  if (!token || !navigator.onLine) return { skipped: true };
  const lastPush = full ? 0 : await getSetting('lastPushAt', 0);
  const since = full ? 0 : await getSetting('serverSince', 0);
  const items = [];
  for (const kind of ['activities', 'routes']) {
    for (const o of await getAll(kind)) if ((o.updatedAt || 0) > lastPush) items.push({ id: `${kind}:${o.id}`, kind, updatedAt: o.updatedAt, data: o });
  }
  const startedAt = Date.now();
  const r = await fetch(apiUrl('/api/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ since, items }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Error ${r.status}`);
  let pulled = 0;
  for (const it of body.items || []) {
    if (!STORES.includes(it.kind) || it.kind === 'kv') continue;
    const local = await get(it.kind, it.data.id);
    if (!local || (local.updatedAt || 0) < it.updatedAt) { await put(it.kind, it.data); pulled++; }
  }
  await setSetting('lastPushAt', startedAt);
  await setSetting('serverSince', body.now || startedAt);
  await setSetting('lastSyncOk', Date.now());
  listeners.forEach(fn => fn({ pushed: items.length, pulled }));
  return { pushed: items.length, pulled };
}

// ---------- backup ----------
export async function exportAll() {
  return {
    app: 'pedal-ba', version: 1, exportedAt: new Date().toISOString(),
    activities: await getAll('activities'), routes: await getAll('routes'),
  };
}

export async function importBackup(data) {
  let n = 0;
  if (Array.isArray(data)) return importLegacy(data);
  for (const kind of ['activities', 'routes']) {
    for (const o of data[kind] || []) {
      if (!o?.id) continue;
      const local = await get(kind, o.id);
      if (!local || (local.updatedAt || 0) < (o.updatedAt || 0)) { await put(kind, o); n++; }
    }
  }
  scheduleSync();
  return n;
}

// Formato de la app vieja "Training Log": [{id,date,type,distance,duration,notes}]
const LEGACY_TYPES = { cinta: 'cinta', calle: 'correr', bicicleta: 'bici', caminata: 'caminar' };
export async function importLegacy(arr) {
  let n = 0;
  for (const w of arr) {
    if (!w || !w.date) continue;
    const id = `legacy-${w.id || w.date + '-' + n}`;
    if (await get('activities', id)) continue;
    const startedAt = new Date(w.date + 'T08:00:00').getTime();
    await put('activities', {
      id, type: LEGACY_TYPES[w.type] || 'correr', source: 'legacy',
      title: '', date: w.date, startedAt,
      durationS: Number(w.duration) || 0, movingS: Number(w.duration) || 0,
      distanceKm: Number(w.distance) || 0, notes: w.notes || '',
      updatedAt: Date.now(),
    });
    n++;
  }
  scheduleSync();
  return n;
}
