// Maniobras de navegación (giros) a partir de la geometría de la ruta.
// Módulo puro: lo usan el servidor (rutas de BRouter) y la app (rutas propias / GPX).

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distM(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function cumulative(coords) {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + distM(coords[i - 1], coords[i]);
  return cum;
}

// Punto de la ruta a `target` metros desde el inicio
function pointAt(coords, cum, target) {
  if (target <= 0) return coords[0];
  const n = coords.length;
  if (target >= cum[n - 1]) return coords[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid; else hi = mid; }
  const seg = cum[hi] - cum[lo] || 1, t = (target - cum[lo]) / seg;
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
}

// Ángulo de giro en el punto i: positivo = derecha, negativo = izquierda
export function turnAngle(coords, cum, i, span = 20) {
  const back = pointAt(coords, cum, cum[i] - span);
  const ahead = pointAt(coords, cum, cum[i] + span);
  if (distM(back, coords[i]) < 2 || distM(coords[i], ahead) < 2) return 0;
  const d = bearing(coords[i], ahead) - bearing(back, coords[i]);
  return ((d + 540) % 360) - 180;
}

export function classify(angle) {
  const a = Math.abs(angle);
  if (a < 15) return 'straight';
  if (a < 35) return 'keep';
  if (a < 60) return 'slight';
  if (a < 130) return 'turn';
  if (a < 165) return 'sharp';
  return 'uturn';
}

const CMD_TYPE = { 2: ['turn', -1], 3: ['slight', -1], 4: ['sharp', -1], 5: ['turn', 1], 6: ['slight', 1], 7: ['sharp', 1], 8: ['keep', -1], 9: ['keep', 1] };

// hints: voicehints de BRouter [[índice, comando, salida de rotonda, ...], ...]. Sin hints, detección geométrica.
export function buildManeuvers(coords, hints) {
  if (!coords || coords.length < 3) return [];
  const cum = cumulative(coords);
  const n = coords.length;
  let cands = [];
  if (Array.isArray(hints) && hints.length) {
    // [índice, comando, salida de rotonda, distancia al siguiente, ángulo (+ derecha)]
    // Comandos de BRouter verificados: 1 seguir, 2 izq., 3 leve izq., 4 cerrado izq.,
    // 5 der., 6 leve der., 7 cerrado der., 8 mantener izq., 9 mantener der.
    for (const h of hints) {
      const i = Number(h[0]), cmd = Number(h[1]), exit = Number(h[2]) || 0, ang = Number(h[4]);
      if (!Number.isInteger(i) || i <= 0 || i >= n - 1) continue;
      if (cmd === 1 && !exit) continue;
      cands.push({ i, exit, span: 20, cmd, angle: Number.isFinite(ang) ? ang : null });
    }
  }
  if (!cands.length) {
    // geométrico: ventanas de 25 m para no confundir ruido o curvas suaves con giros
    const raw = [];
    for (let i = 1; i < n - 1; i++) {
      const a = turnAngle(coords, cum, i, 25);
      if (Math.abs(a) >= 45) raw.push({ i, a });
    }
    for (const c of raw) {
      const better = raw.some(o => o !== c && Math.abs(cum[o.i] - cum[c.i]) < 30 && (Math.abs(o.a) > Math.abs(c.a) || (Math.abs(o.a) === Math.abs(c.a) && o.i < c.i)));
      if (!better) cands.push({ i: c.i, exit: 0, span: 25 });
    }
  }
  const out = [];
  for (const c of cands) {
    let angle = c.angle ?? turnAngle(coords, cum, c.i, c.span);
    const byCmd = CMD_TYPE[c.cmd];
    const type = c.exit > 0 ? 'roundabout' : byCmd ? byCmd[0] : classify(angle);
    // el lado lo manda el comando de BRouter si lo hay
    if (byCmd && Math.sign(angle) !== byCmd[1]) angle = byCmd[1] * Math.max(20, Math.abs(angle));
    if (type === 'straight') continue;
    const m = { i: c.i, d: Math.round(cum[c.i]), angle: Math.round(angle), type, exit: c.exit };
    const prev = out[out.length - 1];
    if (prev && m.d - prev.d < 15) { if (Math.abs(m.angle) > Math.abs(prev.angle)) out[out.length - 1] = m; continue; }
    out.push(m);
  }
  return out;
}

// ---------- textos (voseo rioplatense) ----------
const ORD = ['', 'primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'séptima', 'octava'];
const side = (angle) => (angle < 0 ? 'izquierda' : 'derecha');

export function instruction(m) {
  switch (m.type) {
    case 'keep': return `Mantenete a la ${side(m.angle)}`;
    case 'slight': return `Doblá levemente a la ${side(m.angle)}`;
    case 'turn': return `Doblá a la ${side(m.angle)}`;
    case 'sharp': return `Doblá cerrado a la ${side(m.angle)}`;
    case 'uturn': return 'Pegá la vuelta';
    case 'roundabout': return `En la rotonda, tomá la ${ORD[m.exit] || `salida ${m.exit}`}${ORD[m.exit] ? ' salida' : ''}`;
    case 'arrive': return 'Llegaste a destino';
    default: return 'Seguí derecho';
  }
}

export function spokenDistance(m) {
  if (m >= 1000) {
    const km = Math.round(m / 100) / 10;
    return km === 1 ? '1 kilómetro' : `${String(km).replace('.', ',')} kilómetros`;
  }
  const r = m >= 200 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
  return `${r} metros`;
}

const DIR_NAMES = ['norte', 'noreste', 'este', 'sudeste', 'sur', 'sudoeste', 'oeste', 'noroeste'];
export const compassName = (deg) => DIR_NAMES[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
