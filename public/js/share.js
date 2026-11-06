// Imagen, GIF y video del recorrido (estilo Relive) dibujados en canvas.
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.esm.js';
import { TYPES, fmtKm, fmtDuration, fmtPace, fmtNum, fmtDate, simplify } from './util.js';
import { speedSeries } from './stats.js';

const TILE = 256;
const TILE_URL = (z, x, y) => `https://${'abcd'[(x + y) % 4]}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}@2x.png`;
const tileCache = new Map();

const project = (lat, lon, z) => {
  const s = TILE * 2 ** z, sin = Math.sin(lat * Math.PI / 180);
  return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
};

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, new Promise((resolve) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img); img.onerror = () => resolve(null);
      img.src = TILE_URL(z, x, y);
    }));
  }
  return tileCache.get(key);
}

// Prepara mapa base + proyección del recorrido para un tamaño dado
export async function prepareScene(item, W, H) {
  const raw = item.points.map(p => [p[0], p[1], p[2]]);
  const pts = raw.length > 1500 ? simplify(raw, 0.000015) : raw;
  const box = { x: W * 0.07, y: H * 0.17, w: W * 0.86, h: H * 0.58 };
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of pts) { minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]); minLon = Math.min(minLon, p[1]); maxLon = Math.max(maxLon, p[1]); }
  // zoom fraccional que encaja el recorrido en la caja
  let zf = 18;
  for (; zf > 3; zf -= 0.05) {
    const a = project(maxLat, minLon, zf), b = project(minLat, maxLon, zf);
    if (b[0] - a[0] <= box.w && b[1] - a[1] <= box.h) break;
  }
  const zi = Math.min(18, Math.max(3, Math.floor(zf)));
  const scale = 2 ** (zf - zi);
  const c = project((minLat + maxLat) / 2, (minLon + maxLon) / 2, zf);
  const origin = [c[0] - (box.x + box.w / 2), c[1] - (box.y + box.h / 2)]; // en px del zoom zf
  const toXY = (lat, lon) => { const p = project(lat, lon, zf); return [p[0] - origin[0], p[1] - origin[1]]; };

  // mapa base
  const base = document.createElement('canvas'); base.width = W; base.height = H;
  const bctx = base.getContext('2d');
  bctx.fillStyle = '#0e1013'; bctx.fillRect(0, 0, W, H);
  const tpx = TILE * scale; // tamaño de tile en pantalla
  const ox = origin[0] / scale, oy = origin[1] / scale; // origen en px de zoom entero
  const x0 = Math.floor(ox / TILE), y0 = Math.floor(oy / TILE);
  const x1 = Math.floor((ox + W / scale) / TILE), y1 = Math.floor((oy + H / scale) / TILE);
  const n = 2 ** zi, jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= n) continue;
    jobs.push(loadTile(zi, ((x % n) + n) % n, y).then(img => {
      if (img) bctx.drawImage(img, (x * TILE - ox) * scale, (y * TILE - oy) * scale, tpx + 0.5, tpx + 0.5);
    }));
  }
  await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 9000))]);
  // viñeta para que se lean los textos
  const g1 = bctx.createLinearGradient(0, 0, 0, H * 0.25); g1.addColorStop(0, 'rgba(8,9,11,.95)'); g1.addColorStop(1, 'rgba(8,9,11,0)');
  bctx.fillStyle = g1; bctx.fillRect(0, 0, W, H * 0.25);
  const g2 = bctx.createLinearGradient(0, H * 0.68, 0, H); g2.addColorStop(0, 'rgba(8,9,11,0)'); g2.addColorStop(0.45, 'rgba(8,9,11,.92)'); g2.addColorStop(1, 'rgba(8,9,11,1)');
  bctx.fillStyle = g2; bctx.fillRect(0, H * 0.68, W, H * 0.32);

  const xy = pts.map(p => toXY(p[0], p[1]));
  const hasTime = pts.some(p => p[2] != null) && item.type !== 'ruta';
  const speeds = hasTime ? speedSeries(pts) : null;
  let lo = Infinity, hi = -Infinity;
  if (speeds) { const v = speeds.filter(Number.isFinite).sort((a, b) => a - b); lo = v[Math.floor(v.length * 0.1)] ?? 0; hi = v[Math.floor(v.length * 0.95)] ?? 1; }
  // distancia acumulada para animar a velocidad constante
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { W, H, base, xy, speeds, lo, hi, cum, item };
}

const accentOf = (item) => TYPES[item.type]?.color || '#c6f432';

function speedColor(v, lo, hi) {
  if (!Number.isFinite(v)) return '#c6f432';
  const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1, hi - lo)));
  // azul → verde lima → naranja → rojo
  const stops = [[94, 200, 255], [198, 244, 50], [255, 160, 40], [255, 70, 70]];
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), k = f - i;
  const c = stops[i].map((a, j) => Math.round(a + (stops[i + 1][j] - a) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function drawFrame(ctx, S, progress = 1, { hold = 0 } = {}) {
  const { W, H, xy, cum, speeds, lo, hi, item } = S;
  const u = W / 1080;
  ctx.drawImage(S.base, 0, 0);
  const total = cum[cum.length - 1] || 1;
  const target = total * progress;
  let end = cum.findIndex(c => c >= target); if (end < 0) end = xy.length - 1;
  const accent = accentOf(item);

  // sombra / glow
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 15 * u;
  ctx.beginPath(); xy.slice(0, end + 1).forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
  if (speeds) {
    ctx.lineWidth = 8 * u;
    for (let i = 1; i <= end; i++) {
      ctx.strokeStyle = speedColor(speeds[i], lo, hi);
      ctx.beginPath(); ctx.moveTo(xy[i - 1][0], xy[i - 1][1]); ctx.lineTo(xy[i][0], xy[i][1]); ctx.stroke();
    }
  } else {
    ctx.strokeStyle = accent; ctx.lineWidth = 8 * u;
    ctx.beginPath(); xy.slice(0, end + 1).forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
  }
  // inicio
  const [sx, sy] = xy[0];
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, sy, 11 * u, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0e1013'; ctx.beginPath(); ctx.arc(sx, sy, 5 * u, 0, Math.PI * 2); ctx.fill();
  // punto actual
  const [cx, cy] = xy[end];
  const pulse = 1 + 0.25 * Math.sin((progress * 40 + hold) * Math.PI);
  ctx.fillStyle = hexA(accent, 0.25); ctx.beginPath(); ctx.arc(cx, cy, 26 * u * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(cx, cy, 13 * u, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#0e1013'; ctx.lineWidth = 4 * u; ctx.stroke();

  drawTexts(ctx, S, progress, u, accent);
}

function drawTexts(ctx, S, progress, u, accent) {
  const { W, H, item } = S;
  const T = TYPES[item.type];
  ctx.textBaseline = 'alphabetic';
  // encabezado
  ctx.fillStyle = accent; ctx.font = `800 ${30 * u}px Inter, system-ui, sans-serif`;
  ctx.fillText(`${T ? T.label.toUpperCase() : 'RUTA'}${item.date ? ' · ' + fmtDate(item.startedAt || item.date, { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase() : ''}`, 70 * u, 92 * u);
  ctx.fillStyle = '#fff'; ctx.font = `800 ${54 * u}px Inter, system-ui, sans-serif`;
  ctx.fillText(clip(ctx, item.title || 'Mi recorrido', W - 140 * u), 70 * u, 160 * u);

  // estadísticas (la distancia sube con la animación)
  const km = (item.distanceKm || 0) * Math.min(1, progress);
  const stats = [[fmtKm(km), 'km']];
  if (item.type === 'ruta') {
    if (item.share) stats.push([`${Math.round(item.share.bike * 100)}%`, 'ciclovía']);
    if (item.ascentM) stats.push([`${item.ascentM}`, 'm desnivel']);
  } else {
    const sec = item.movingS || item.durationS;
    stats.push([fmtDuration(sec * Math.min(1, progress)), 'tiempo']);
    if (item.type === 'bici') stats.push([fmtNum(item.avgKmh || (item.distanceKm / (sec / 3600)), 1), 'km/h prom.']);
    else stats.push([fmtPace(item.distanceKm, sec), 'min/km']);
    if (item.type === 'bici' && item.maxKmh) stats.push([fmtNum(item.maxKmh, 1), 'km/h máx.']);
  }
  const colW = (W - 140 * u) / stats.length;
  stats.forEach(([v, l], i) => {
    const x = 70 * u + colW * i;
    ctx.fillStyle = '#fff'; ctx.font = `800 ${(i === 0 ? 92 : 64) * u}px Inter, system-ui, sans-serif`;
    ctx.fillText(v, x, H - 150 * u);
    ctx.fillStyle = '#9aa3ad'; ctx.font = `600 ${26 * u}px Inter, system-ui, sans-serif`;
    ctx.fillText(l, x, H - 108 * u);
  });
  // pie
  ctx.fillStyle = accent; ctx.font = `900 ${28 * u}px Inter, system-ui, sans-serif`;
  ctx.fillText('PEDAL BA', 70 * u, H - 44 * u);
  ctx.fillStyle = '#6b737c'; ctx.font = `500 ${18 * u}px Inter, system-ui, sans-serif`;
  const attr = '© OpenStreetMap · © CARTO';
  ctx.fillText(attr, W - 70 * u - ctx.measureText(attr).width, H - 44 * u);
}

function clip(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 3 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const ease = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

export async function makeImage(item) {
  const S = await prepareScene(item, 1080, 1350);
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1350;
  drawFrame(c.getContext('2d'), S, 1);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

export async function makeGif(item, onProgress) {
  const W = 540, H = 675;
  const S = await prepareScene(item, W, H);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const frames = 54, holdFrames = 14;
  // paleta común sacada del último cuadro (tiene todos los colores del recorrido)
  drawFrame(ctx, S, 1);
  const palette = quantize(ctx.getImageData(0, 0, W, H).data, 256, { format: 'rgb444' });
  const gif = GIFEncoder();
  for (let f = 0; f < frames + holdFrames; f++) {
    const prog = f < frames ? ease((f + 1) / frames) : 1;
    drawFrame(ctx, S, prog, { hold: f });
    const index = applyPalette(ctx.getImageData(0, 0, W, H).data, palette, 'rgb444');
    gif.writeFrame(index, W, H, { palette: f === 0 ? palette : undefined, delay: f < frames ? 60 : (f === frames + holdFrames - 1 ? 2500 : 80) });
    onProgress?.((f + 1) / (frames + holdFrames));
    if (f % 4 === 0) await new Promise(r => setTimeout(r));
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

export function videoSupported() {
  return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
}

export async function makeVideo(item, onProgress) {
  const W = 1080, H = 1350;
  const S = await prepareScene(item, W, H);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  drawFrame(ctx, S, 0);
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = types.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6 } : undefined);
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => (rec.onstop = r));
  rec.start(250);
  const anim = 8000, hold = 2000, t0 = performance.now();
  await new Promise(resolve => {
    const step = (now) => {
      const t = now - t0;
      drawFrame(ctx, S, ease(Math.min(1, t / anim)), { hold: t / 120 });
      onProgress?.(Math.min(1, t / (anim + hold)));
      if (t < anim + hold) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  rec.stop(); await done;
  const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
  return new Blob(chunks, { type });
}
