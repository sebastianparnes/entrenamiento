// Pedal BA — servidor sin dependencias (Node 18+ o Bun).
// Sirve la PWA y hace de proxy a BRouter (ruteo en bici sobre OpenStreetMap),
// Open-Meteo (clima) y Nominatim (búsqueda de direcciones). Además guarda una
// copia de tus actividades si configurás APP_TOKEN y un volumen en DATA_DIR.

import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeBrouter } from './lib/brouter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_TOKEN = process.env.APP_TOKEN || '';
const BROUTER = process.env.BROUTER_URL || 'https://brouter.de/brouter';
const UA = 'PedalBA/1.0 (app personal de ciclismo)';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};

// ---------- cache simple en memoria ----------
const cache = new Map();
function cached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  return undefined;
}
function store(key, v) {
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(text.slice(0, 300) || `HTTP ${r.status}`), { status: r.status });
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limit = 15 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Body demasiado grande'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- API: ruteo ----------
const PROFILES = new Set(['trekking', 'fastbike', 'safety', 'shortest']);
async function apiRoute(q) {
  const pts = (q.get('pts') || '').split(/\||;|~|%7C/i).map(s => s.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
  if (pts.length < 2 || pts.length > 30) throw Object.assign(new Error('Necesito entre 2 y 30 puntos'), { status: 400 });
  const profile = PROFILES.has(q.get('profile')) ? q.get('profile') : 'trekking';
  const lonlats = pts.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join('|');
  const key = `route:${profile}:${lonlats}`;
  const hit = cached(key, 6 * 3600e3); if (hit) return hit;
  const url = `${BROUTER}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  const gj = await fetchJson(url, { timeout: 40000 });
  return store(key, analyzeBrouter(gj));
}

// ---------- API: clima ----------
async function apiWeather(q) {
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw Object.assign(new Error('lat/lon inválidos'), { status: 400 });
  const key = `wx:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  const hit = cached(key, 20 * 60e3); if (hit) return hit;
  const url = (process.env.OPEN_METEO_URL || 'https://api.open-meteo.com/v1/forecast') + '?' + new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'America/Argentina/Buenos_Aires',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily: 'sunrise,sunset,uv_index_max,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    forecast_days: '3', wind_speed_unit: 'kmh',
  });
  return store(key, await fetchJson(url));
}

// ---------- API: geocoding ----------
async function apiGeocode(q) {
  const text = (q.get('q') || '').trim();
  if (text.length < 3) throw Object.assign(new Error('Escribí al menos 3 letras'), { status: 400 });
  const key = `geo:${text.toLowerCase()}`;
  const hit = cached(key, 7 * 86400e3); if (hit) return hit;
  const url = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search') + '?' + new URLSearchParams({
    q: text, format: 'jsonv2', limit: '6', countrycodes: 'ar', 'accept-language': 'es',
    viewbox: '-58.75,-34.35,-58.30,-34.75', bounded: '0',
  });
  const arr = await fetchJson(url);
  return store(key, arr.map(r => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon) })));
}

// ---------- API: sincronización de actividades ----------
const DB_FILE = path.join(DATA_DIR, 'pedal-db.json');
let dbLock = Promise.resolve();
async function loadDb() {
  try { return JSON.parse(await readFile(DB_FILE, 'utf8')); } catch { return { items: {} }; }
}
async function saveDb(db) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(db));
  await rename(tmp, DB_FILE);
}
function authed(req) {
  if (!APP_TOKEN) return false;
  const h = req.headers.authorization || '';
  return h === `Bearer ${APP_TOKEN}`;
}
// items: { id: { kind: 'activity'|'route', updatedAt, deleted?, data } }
async function apiSync(req) {
  const incoming = JSON.parse(await readBody(req) || '{}');
  const run = dbLock.then(async () => {
    const db = await loadDb();
    for (const it of incoming.items || []) {
      if (!it || typeof it.id !== 'string' || !it.updatedAt) continue;
      const cur = db.items[it.id];
      if (!cur || cur.updatedAt < it.updatedAt) db.items[it.id] = it;
    }
    await saveDb(db);
    const since = Number(incoming.since || 0);
    return { now: Date.now(), items: Object.values(db.items).filter(x => x.updatedAt > since) };
  });
  dbLock = run.catch(() => {});
  return run;
}

// ---------- estáticos ----------
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Prohibido');
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error();
    const ext = path.extname(file);
    const noCache = ext === '.html' || rel === '/sw.js' || rel === '/manifest.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(await readFile(file));
  } catch {
    send(res, 404, 'No encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, sync: Boolean(APP_TOKEN), persistent: existsSync(DATA_DIR) });
    if (p === '/api/route') return send(res, 200, await apiRoute(url.searchParams), { 'Cache-Control': 'public, max-age=3600' });
    if (p === '/api/weather') return send(res, 200, await apiWeather(url.searchParams), { 'Cache-Control': 'public, max-age=600' });
    if (p === '/api/geocode') return send(res, 200, await apiGeocode(url.searchParams));
    if (p === '/api/sync') {
      if (!APP_TOKEN) return send(res, 503, { error: 'Sincronización no configurada en el servidor (APP_TOKEN)' });
      if (!authed(req)) return send(res, 401, { error: 'Clave incorrecta' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Usar POST' });
      return send(res, 200, await apiSync(req));
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'No existe' });
    return serveStatic(req, res, p);
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    console.error(p, e.message);
    send(res, status, { error: e.name === 'AbortError' ? 'El servicio externo tardó demasiado' : e.message });
  }
});

server.listen(PORT, () => console.log(`Pedal BA escuchando en :${PORT} (sync ${APP_TOKEN ? 'activado' : 'desactivado'}, datos en ${DATA_DIR})`));
