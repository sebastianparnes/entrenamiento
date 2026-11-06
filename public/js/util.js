// Utilidades generales: formato, geometría, DOM.
import { isNative, apiUrl, nativeShare } from './native.js';

export const TYPES = {
  bici:    { label: 'Bici',    emoji: '🚴', color: '#c6f432', gps: true,  speed: true },
  correr:  { label: 'Correr',  emoji: '🏃', color: '#ff8a3d', gps: true,  speed: false },
  caminar: { label: 'Caminar', emoji: '🚶', color: '#5ec8ff', gps: true,  speed: false },
  cinta:   { label: 'Cinta',   emoji: '🏋️', color: '#c38bff', gps: false, speed: false },
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- formato ----------
const nf = (d) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtNum = (x, d = 1) => (Number.isFinite(x) ? nf(d).format(x) : '—');
export const fmtKm = (km) => fmtNum(km, km >= 100 ? 0 : km >= 10 ? 1 : 2);

export function fmtDuration(sec, withSec = true) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  if (!withSec) return hh ? `${hh} h ${String(mm).padStart(2, '0')} min` : `${mm} min`;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

export function fmtPace(km, sec) {
  if (!km || !sec || km < 0.01) return '—';
  const p = sec / km;
  if (p > 3600) return '—';
  return `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, '0')}`;
}

export function fmtSpeed(km, sec) {
  if (!km || !sec) return '—';
  return fmtNum(km / (sec / 3600), 1);
}

export function parseDuration(str) {
  // acepta "45", "45:30", "1:05:00", "1h05", "90m"
  str = String(str || '').trim().toLowerCase();
  if (!str) return NaN;
  const hm = str.match(/^(\d+)\s*h\s*(\d+)?/);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2] || 0) * 60;
  const m = str.match(/^(\d+)\s*m(in)?$/);
  if (m) return Number(m[1]) * 60;
  const parts = str.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return NaN;
  if (parts.length === 1) return parts[0] * 60;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString('es-AR', opts);
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

export function startOfWeek(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}

// ---------- geometría ----------
const R = 6371000;
const toRad = d => (d * Math.PI) / 180;
const toDeg = r => (r * 180) / Math.PI;

export function distM(a, b) {
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(p, brgDeg, meters) {
  const d = meters / R, b = toRad(brgDeg), la1 = toRad(p[0]), lo1 = toRad(p[1]);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [toDeg(la2), toDeg(lo2)];
}

export const angleDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };

export function pathLengthKm(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distM(pts[i - 1], pts[i]);
  return m / 1000;
}

const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const compass = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const DIR_NAMES = { N: 'norte', NE: 'noreste', E: 'este', SE: 'sudeste', S: 'sur', SO: 'sudoeste', O: 'oeste', NO: 'noroeste' };
export const compassName = deg => DIR_NAMES[['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]];

// Simplificación Douglas-Peucker (en grados, suficiente para dibujar)
export function simplify(pts, tol = 0.00002) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = [pts[a][1], pts[a][0]], [bx, by] = [pts[b][1], pts[b][0]];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-18;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][1], py = pts[i][0];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2; t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------- UI ----------
let toastTimer;
export function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function sheet(title, content, { onClose } = {}) {
  const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 220); onClose?.(); };
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Cerrar', onclick: close }, '✕')),
      h('div', { class: 'sheet-body' }, content)));
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return { close, el: wrap };
}

export function download(blob, filename) {
  if (isNative) { nativeShare(blob, filename, filename).catch(e => toast(e.message)); return; }
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function shareOrDownload(blob, filename, title) {
  if (isNative) return nativeShare(blob, filename, title);
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  download(blob, filename);
  return 'downloaded';
}

export async function api(path, opts = {}) {
  const r = await fetch(apiUrl(path), opts);
  const isJson = (r.headers.get('content-type') || '').includes('json');
  const body = isJson ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body?.error || body || `Error ${r.status}`);
  return body;
}
