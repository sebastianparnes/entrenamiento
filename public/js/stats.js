// Cálculos sobre actividades: distancia, tiempo en movimiento, velocidades, parciales.
import { distM, startOfWeek, TYPES } from './util.js';

// points: [lat, lon, tSec, ele]
export function computeStats(points, type = 'bici') {
  let dist = 0, moving = 0, maxKmh = 0, ascent = 0;
  const minMove = type === 'bici' ? 2.5 : 1.2; // km/h para considerar "en movimiento"
  const splits = [];
  let nextSplit = 1000, splitStartT = points[0]?.[2] ?? 0;
  const win = [];
  let lastEle = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = distM(a, b);
    const dt = (b[2] ?? 0) - (a[2] ?? 0);
    dist += d;
    if (dt > 0) {
      const kmh = (d / dt) * 3.6;
      if (kmh >= minMove && dt < 120) moving += dt;
      win.push([d, dt]); if (win.length > 4) win.shift();
      const wd = win.reduce((s, x) => s + x[0], 0), wt = win.reduce((s, x) => s + x[1], 0);
      if (wt >= 6) maxKmh = Math.max(maxKmh, Math.min((wd / wt) * 3.6, type === 'bici' ? 80 : 30));
    }
    if (b[3] != null) {
      if (lastEle == null) lastEle = b[3];
      else if (b[3] - lastEle > 3) { ascent += b[3] - lastEle; lastEle = b[3]; }
      else if (lastEle - b[3] > 3) lastEle = b[3];
    }
    while (dist >= nextSplit && b[2] != null) {
      splits.push({ km: nextSplit / 1000, sec: b[2] - splitStartT });
      splitStartT = b[2]; nextSplit += 1000;
    }
  }
  const last = points[points.length - 1];
  const elapsed = last?.[2] ?? 0;
  if (!moving) moving = elapsed;
  return {
    distanceKm: dist / 1000, durationS: elapsed, movingS: moving,
    avgKmh: moving ? (dist / 1000) / (moving / 3600) : 0, maxKmh, ascentM: Math.round(ascent), splits,
  };
}

// Velocidad por punto (suavizada) para colorear el recorrido
export function speedSeries(points) {
  const out = new Array(points.length).fill(null);
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 3)], b = points[Math.min(points.length - 1, i + 3)];
    const dt = (b[2] ?? 0) - (a[2] ?? 0);
    if (dt > 0) {
      let d = 0;
      for (let k = Math.max(0, i - 3) + 1; k <= Math.min(points.length - 1, i + 3); k++) d += distM(points[k - 1], points[k]);
      out[i] = (d / dt) * 3.6;
    }
  }
  return out;
}

export function periodTotals(acts, from, to = Date.now()) {
  const res = { km: 0, sec: 0, n: 0, byType: {} };
  for (const a of acts) {
    if (a.startedAt < from || a.startedAt >= to) continue;
    res.km += a.distanceKm || 0; res.sec += a.movingS || a.durationS || 0; res.n++;
    const t = (res.byType[a.type] ||= { km: 0, sec: 0, n: 0 });
    t.km += a.distanceKm || 0; t.sec += a.movingS || a.durationS || 0; t.n++;
  }
  return res;
}

export function weeklySeries(acts, weeks = 12) {
  const start = startOfWeek(new Date());
  const out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const from = new Date(start); from.setDate(from.getDate() - 7 * w);
    const to = new Date(from); to.setDate(to.getDate() + 7);
    const tot = periodTotals(acts, from.getTime(), to.getTime());
    out.push({ from, byType: Object.fromEntries(Object.keys(TYPES).map(k => [k, tot.byType[k]?.km || 0])), km: tot.km });
  }
  return out;
}
