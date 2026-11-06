// Rutas sugeridas, ruteo vía /api/route (BRouter sobre OpenStreetMap) y la
// recomendación del día según clima, viento, hora y día de la semana.

import { api, distM, bearing, angleDiff, destination, compassName, fmtNum } from './util.js';
import { get, put } from './store.js';

export const DEFAULT_HOME = { label: 'Chorroarín 530, CABA', lat: -34.5904, lon: -58.4748 };

export const PROFILES = {
  safety:   { label: 'Máx. ciclovía', hint: 'Prioriza ciclovías y calles tranquilas aunque alargue un poco' },
  trekking: { label: 'Equilibrado',   hint: 'Mezcla ciclovías con caminos directos' },
  fastbike: { label: 'Entreno',       hint: 'Asfalto y fluidez: más avenidas, menos esquinas' },
};

// waypoints: [lat, lon]. La ruta es casa → waypoints → casa.
// training: qué tan bien se presta para tirar velocidad (1-5).
// exposure: cuánto te pega el viento (0 = protegida, 1 = costanera abierta).
export const CURATED = [
  {
    id: 'bosques', name: 'Bosques de Palermo · 3 vueltas al Rosedal',
    tagline: 'El circuito clásico para entrenar: asfalto liso y vueltas sin semáforos.',
    training: 5, exposure: 0.5, approxKm: 26, weekendBonus: true,
    tips: 'Los fines de semana y feriados el circuito de los lagos suele estar cerrado a los autos: ideal para meter ritmo. Entre semana, temprano a la mañana está más tranquilo.',
    waypoints: [[-34.5822, -58.4555], [-34.571, -58.4172], [-34.5662, -58.4152], [-34.5697, -58.4116], [-34.571, -58.4172], [-34.5662, -58.4152], [-34.5697, -58.4116], [-34.571, -58.4172], [-34.5662, -58.4152], [-34.5697, -58.4116], [-34.571, -58.4172], [-34.5822, -58.4555]],
  },
  {
    id: 'costanera', name: 'Costanera Norte + Ciudad Universitaria',
    tagline: 'Rectas largas junto al río y Parque de la Memoria. Mucho viento.',
    training: 4, exposure: 1, approxKm: 29, night: false,
    tips: 'Con viento del norte salí hacia la costanera de entrada (contra) y volvé empujado. De noche es más solitaria: mejor de día.',
    waypoints: [[-34.5822, -58.4555], [-34.5697, -58.4116], [-34.5617, -58.4004], [-34.5394, -58.4422], [-34.546, -58.462], [-34.5535, -58.487]],
  },
  {
    id: 'vicente-lopez', name: 'Paseo de la Costa · Vicente López y Puerto de Olivos',
    tagline: 'Bicisenda costera en zona norte, río a la derecha y vuelta por Saavedra.',
    training: 4, exposure: 0.9, approxKm: 28,
    tips: 'El paseo costero tiene sectores con mucha gente el fin de semana a la tarde; para tirar ritmo, temprano.',
    waypoints: [[-34.5535, -58.487], [-34.5229, -58.4684], [-34.5056, -58.4745], [-34.53, -58.487]],
  },
  {
    id: 'san-isidro', name: 'Hasta San Isidro · fondo largo',
    tagline: 'La más larga (~38 km): Puerto de Olivos, Martínez y la Catedral de San Isidro.',
    training: 3, exposure: 0.6, approxKm: 38,
    tips: 'Buena para fondo. Llevá agua: casi todo el trayecto es urbano pero con tramos sin sombra.',
    waypoints: [[-34.5056, -58.4745], [-34.4672, -58.5091]],
  },
  {
    id: 'sarmiento', name: 'Parque Sarmiento, Devoto y Parque Centenario',
    tagline: 'Vuelta por barrios y parques con mucha ciclovía, protegida del viento.',
    training: 3, exposure: 0.2, approxKm: 29,
    tips: 'La opción para días ventosos: casi todo entre edificios y arboledas.',
    waypoints: [[-34.5533, -58.4981], [-34.6007, -58.5133], [-34.6065, -58.4355]],
  },
  {
    id: 'madero', name: 'Puerto Madero y Costanera Sur',
    tagline: 'Paseo urbano largo por ciclovías protegidas hasta la Reserva Ecológica.',
    training: 2, exposure: 0.6, approxKm: 32,
    tips: 'Más paseo que entreno: muchos semáforos en el centro. Lindo para ir tranquilo y parar en la Reserva.',
    waypoints: [[-34.5697, -58.4116], [-34.608, -58.364], [-34.6155, -58.3575]],
  },
];

const hashWps = (w) => { const t = JSON.stringify(w); let x = 0; for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };
export const homeKey = (home) => `${home.lat.toFixed(4)},${home.lon.toFixed(4)}`;

export function routePoints(route, home) {
  const wps = route.waypoints || [];
  if (route.isLoop === false) return [[home.lat, home.lon], ...wps];
  return [[home.lat, home.lon], ...wps, [home.lat, home.lon]];
}

// Pide el ruteo al servidor y lo guarda en caché local (IndexedDB)
export async function computeRoute(route, home, profile = 'trekking', { force = false } = {}) {
  const pts = route.coords && !route.waypoints ? null : routePoints(route, home);
  if (!pts) return { coords: route.coords, spans: route.spans || [{ from: 0, to: route.coords.length - 1, cls: 'road' }], distanceKm: route.distanceKm, ascentM: route.ascentM || 0, share: route.share || null };
  const key = `route:${route.id}:${profile}:${homeKey(home)}:${hashWps(route.waypoints)}`;
  if (!force) {
    const c = await get('kv', key);
    if (c && Date.now() - c.value.t < 30 * 86400e3) return c.value.data;
  }
  const q = pts.map(([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join('|');
  const data = await api(`/api/route?profile=${profile}&pts=${encodeURIComponent(q)}`);
  await put('kv', { id: key, value: { t: Date.now(), data } });
  return data;
}

export async function cachedRoute(route, home, profile = 'trekking') {
  if (route.coords && !route.waypoints) return { coords: route.coords, distanceKm: route.distanceKm, share: route.share || null };
  const key = `route:${route.id}:${profile}:${homeKey(home)}:${hashWps(route.waypoints)}`;
  const c = await get('kv', key);
  return c ? c.value.data : null;
}

// Loop generado: triángulo casa → A → B → casa con el rumbo indicado
export function makeLoop(home, km, brg) {
  const side = (km / 3 / 1.22) * 1000;
  const a = destination([home.lat, home.lon], brg - 25, side);
  const b = destination([home.lat, home.lon], brg + 35, side);
  return {
    id: `loop-${Math.round(km)}-${Math.round(brg)}`, name: `Loop de ~${Math.round(km)} km hacia el ${compassName(brg)}`,
    tagline: 'Ruta generada a medida', training: 3, exposure: 0.5, approxKm: km, generated: true,
    waypoints: [a, b],
  };
}

// Rumbo de salida "medio": de casa al punto más lejano del recorrido
export function outboundBearing(points, home) {
  let far = points[0], fd = -1;
  for (const p of points) { const d = distM([home.lat, home.lon], p); if (d > fd) { fd = d; far = p; } }
  return bearing([home.lat, home.lon], far);
}

// ---------- clima → recomendación ----------
export function summarizeWeather(wx) {
  if (!wx?.hourly) return null;
  const now = Date.now();
  const H = wx.hourly;
  const idx = H.time.findIndex(t => new Date(t).getTime() > now - 3600e3);
  const take = (arr, n = 3) => arr.slice(Math.max(0, idx), Math.max(0, idx) + n);
  const precipProb = Math.max(0, ...take(H.precipitation_probability));
  const precipMm = take(H.precipitation).reduce((s, x) => s + (x || 0), 0);
  const windAvg = avg(take(H.wind_speed_10m));
  const gustMax = Math.max(0, ...take(H.wind_gusts_10m));
  const windDir = circularMean(take(H.wind_direction_10m));
  const c = wx.current || {};
  const sunset = wx.daily?.sunset?.[0] ? new Date(wx.daily.sunset[0]).getTime() : null;
  const sunrise = wx.daily?.sunrise?.[0] ? new Date(wx.daily.sunrise[0]).getTime() : null;
  return {
    temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, isDay: c.is_day,
    windNow: c.wind_speed_10m, windDirNow: c.wind_direction_10m, gustNow: c.wind_gusts_10m,
    precipProb, precipMm, windAvg, gustMax, windDir,
    sunset, sunrise, uv: wx.daily?.uv_index_max?.[0],
    max: wx.daily?.temperature_2m_max?.[0], min: wx.daily?.temperature_2m_min?.[0],
  };
}

export function recommend(sw, routes, home, now = new Date()) {
  const reasons = [];
  const dow = now.getDay();
  const weekend = dow === 0 || dow === 6;
  const t = now.getTime();
  const dark = sw && sw.sunset && sw.sunrise && (t > sw.sunset - 30 * 60e3 || t < sw.sunrise);
  let mode = 'bici';

  if (sw) {
    if (sw.precipProb >= 60 || sw.precipMm >= 1) {
      mode = 'cinta';
      reasons.push(`Llueve o es probable que llueva en las próximas horas (${Math.round(sw.precipProb)}%): día de cinta o de salir más tarde.`);
    } else if (sw.precipProb >= 35) {
      reasons.push(`Hay ${Math.round(sw.precipProb)}% de chance de lluvia: elegí algo cerca de casa.`);
    }
    if (sw.windAvg >= 30 || sw.gustMax >= 50) reasons.push(`Viento fuerte del ${compassName(sw.windDir)} (${Math.round(sw.windAvg)} km/h, ráfagas de ${Math.round(sw.gustMax)}): mejor rutas protegidas.`);
    else if (sw.windAvg >= 15) reasons.push(`Viento del ${compassName(sw.windDir)} a ${Math.round(sw.windAvg)} km/h: salí contra el viento y volvé con él a favor.`);
    else reasons.push(`Viento suave (${Math.round(sw.windAvg)} km/h): buen día para tirar velocidad.`);
    if (sw.temp >= 30) reasons.push(`Hace ${Math.round(sw.temp)}°: salí temprano o al atardecer y llevá agua extra.`);
    if (sw.temp <= 8) reasons.push(`Hace ${Math.round(sw.temp)}°: abrigá manos y orejas los primeros km.`);
    if (dark) reasons.push('Es de noche: luces delantera y trasera, y preferí recorridos iluminados.');
  }
  if (weekend) reasons.push('Es fin de semana: los lagos de Palermo suelen estar cerrados al tránsito.');

  const scored = routes.map(r => {
    let s = r.training * 2;
    const why = [];
    const pts = r._data?.coords?.length ? r._data.coords : routePoints(r, home);
    const out = outboundBearing(pts, home);
    if (sw) {
      const wind = sw.windAvg || 0;
      const diff = angleDiff(out, sw.windDir); // viento VIENE de windDir; diff chico = de frente al salir
      if (wind >= 12) {
        if (diff < 60) { s += 2; why.push('ida con viento en contra, vuelta a favor'); }
        else if (diff > 120) { s -= 1.5 * r.exposure * (wind / 20); why.push('vuelta con viento en contra'); }
      }
      if (wind >= 25) s -= r.exposure * (wind / 10);
      if (sw.temp >= 28 && r.exposure > 0.7) { s += 1; why.push('brisa del río'); }
    }
    if (weekend && r.weekendBonus) { s += 2; why.push('circuito sin autos el finde'); }
    if (dark && r.exposure >= 0.9) { s -= 2; why.push('muy solitaria de noche'); }
    const share = r._data?.share;
    if (share) { s += share.bike * 4; if (share.bike >= 0.4) why.push(`${Math.round(share.bike * 100)}% por ciclovía`); }
    const km = r._data?.distanceKm || r.approxKm;
    if (km < 22 || km > 36) s -= 1;
    return { route: r, score: s, why, outbound: out };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  let headline;
  if (mode === 'cinta') headline = 'Hoy conviene cinta o esperar a que pare';
  else if (top) headline = `Hoy te conviene: ${top.route.name}`;
  return { mode, headline, reasons, ranked: scored };
}

function avg(arr) { const v = arr.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
function circularMean(degs) {
  const v = degs.filter(Number.isFinite); if (!v.length) return 0;
  const sx = v.reduce((s, d) => s + Math.cos(d * Math.PI / 180), 0), sy = v.reduce((s, d) => s + Math.sin(d * Math.PI / 180), 0);
  return (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
}

export const WEATHER_CODES = {
  0: ['Despejado', '☀️'], 1: ['Mayormente despejado', '🌤️'], 2: ['Parcialmente nublado', '⛅'], 3: ['Nublado', '☁️'],
  45: ['Niebla', '🌫️'], 48: ['Niebla', '🌫️'], 51: ['Llovizna', '🌦️'], 53: ['Llovizna', '🌦️'], 55: ['Llovizna fuerte', '🌧️'],
  61: ['Lluvia débil', '🌦️'], 63: ['Lluvia', '🌧️'], 65: ['Lluvia fuerte', '🌧️'], 80: ['Chaparrones', '🌦️'], 81: ['Chaparrones', '🌧️'],
  82: ['Chaparrones fuertes', '⛈️'], 95: ['Tormenta', '⛈️'], 96: ['Tormenta con granizo', '⛈️'], 99: ['Tormenta con granizo', '⛈️'],
};
export const wxLabel = (code) => WEATHER_CODES[code] || ['—', '🌡️'];

export function googleMapsLink(points) {
  const [o, ...rest] = points;
  const d = rest.pop() || o;
  const stride = Math.max(1, Math.ceil(rest.length / 8));
  const wps = rest.filter((_, i) => i % stride === 0).slice(0, 8);
  const p = (x) => `${x[0].toFixed(5)},${x[1].toFixed(5)}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${p(o)}&destination=${p(d)}${wps.length ? '&waypoints=' + wps.map(p).join('%7C') : ''}&travelmode=bicycling`;
}

export const shareLabel = (share) => share ? `${fmtNum(share.bike * 100, 0)}% ciclovía · ${fmtNum(share.calm * 100, 0)}% calles tranquilas` : '';
