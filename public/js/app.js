import {
  TYPES, $, h, esc, uid, fmtKm, fmtNum, fmtDuration, fmtPace, fmtSpeed, fmtDate, fmtTime, todayISO,
  parseDuration, startOfWeek, compass, compassName, toast, sheet, download, shareOrDownload, api, angleDiff,
} from './util.js';
import * as store from './store.js';
import {
  CURATED, DEFAULT_HOME, PROFILES, computeRoute, cachedRoute, routePoints, makeLoop, recommend,
  summarizeWeather, wxLabel, googleMapsLink, outboundBearing, shareLabel,
} from './routes.js';
import { Recorder } from './recorder.js';
import { computeStats, periodTotals, weeklySeries } from './stats.js';
import { toGPX, parseGPX } from './gpx.js';
import { Navigator, arrowSvg } from './nav.js';
import { spokenDistance } from './maneuvers.js';
import { isNative, apiUrl, speak, APK_URL, currentBuild, latestBuild, openExternal, setupBackButton, minimizeApp } from './native.js';

const app = $('#app');
const S = { home: DEFAULT_HOME, profile: 'trekking', voice: true, keepScreen: true, weather: null, wxAt: 0, generated: new Map(), maps: [] };

// ======================= mapas =======================
const tiles = (style) => apiUrl(`/tiles/${style}/{z}/{x}/{y}.png`);
const BASES = {
  'Ciclovías (CyclOSM)': () => L.tileLayer(tiles('cyclosm'), { maxZoom: 20, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://www.cyclosm.org">CyclOSM</a>' }),
  'Claro': () => L.tileLayer(tiles('light'), { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
  'Oscuro': () => L.tileLayer(tiles('dark'), { maxZoom: 16, attribution: '© Esri · © OpenStreetMap' }),
};
const OVERLAYS = {
  'Rutas ciclistas señalizadas': () => L.tileLayer(tiles('bikeroutes'), { maxZoom: 18, opacity: 0.8, attribution: '© <a href="https://cycling.waymarkedtrails.org">Waymarked Trails</a>' }),
};
const CLS_COLOR = { bike: '#22c55e', calm: '#3b82f6', road: '#f97316' };

function makeMap(el, { base = 'Ciclovías (CyclOSM)', overlay = false } = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([S.home.lat, S.home.lon], 13);
  const bases = Object.fromEntries(Object.entries(BASES).map(([k, f]) => [k, f()]));
  const overs = Object.fromEntries(Object.entries(OVERLAYS).map(([k, f]) => [k, f()]));
  bases[base].addTo(map);
  if (overlay) Object.values(overs)[0].addTo(map);
  L.control.layers(bases, overs, { position: 'topright' }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.marker([S.home.lat, S.home.lon], { icon: L.divIcon({ className: '', html: '<div class="home-pin">🏠</div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(map);
  S.maps.push(map);
  setTimeout(() => map.invalidateSize(), 60);
  return map;
}

function drawRoute(map, data, { fit = true } = {}) {
  const layer = L.layerGroup().addTo(map);
  const ll = data.coords.map(c => [c[0], c[1]]);
  L.polyline(ll, { color: '#0b0d10', weight: 9, opacity: 0.55 }).addTo(layer);
  for (const sp of data.spans || [{ from: 0, to: ll.length - 1, cls: 'bike' }]) {
    L.polyline(ll.slice(sp.from, sp.to + 1), { color: CLS_COLOR[sp.cls] || '#c6f432', weight: 5, opacity: 0.95 }).addTo(layer);
  }
  if (ll.length > 1) addArrows(layer, ll);
  if (fit && ll.length) map.fitBounds(L.latLngBounds(ll), { padding: [24, 24] });
  return layer;
}

function addArrows(layer, ll) {
  const n = Math.min(10, Math.floor(ll.length / 40));
  for (let k = 1; k <= n; k++) {
    const i = Math.floor((ll.length * k) / (n + 1));
    const a = ll[i], b = ll[Math.min(ll.length - 1, i + 3)];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    L.marker(a, { interactive: false, icon: L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: `<div style="transform:rotate(${ang}deg);color:#fff;font-size:13px;text-shadow:0 0 3px #000;line-height:14px;text-align:center">▲</div>` }) }).addTo(layer);
  }
}

function drawTrack(map, pts, color = '#c6f432') {
  const ll = pts.map(p => [p[0], p[1]]);
  L.polyline(ll, { color: '#0b0d10', weight: 8, opacity: 0.5 }).addTo(map);
  const line = L.polyline(ll, { color, weight: 5 }).addTo(map);
  if (ll.length) {
    L.circleMarker(ll[0], { radius: 6, color: '#fff', fillColor: '#0b0d10', fillOpacity: 1, weight: 3 }).addTo(map);
    L.circleMarker(ll[ll.length - 1], { radius: 6, color: '#0b0d10', fillColor: color, fillOpacity: 1, weight: 3 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [24, 24] });
  }
  return line;
}

function clearMaps() { S.maps.forEach(m => { try { m.remove(); } catch {} }); S.maps = []; }

// ======================= helpers de UI =======================
const typeLabel = (t) => `${TYPES[t]?.emoji || ''} ${TYPES[t]?.label || t}`;
const mixbar = (share) => share ? h('div', {},
  h('div', { class: 'mixbar' },
    h('span', { style: { width: `${share.bike * 100}%`, background: 'var(--bike)' } }),
    h('span', { style: { width: `${share.calm * 100}%`, background: 'var(--calm)' } }),
    h('span', { style: { width: `${share.road * 100}%`, background: 'var(--road)' } }))) : h('div', { class: 'skeleton', style: { margin: '10px 0' } });
const legend = (share) => h('div', { class: 'legend' },
  h('span', {}, h('i', { style: { background: 'var(--bike)' } }), `Ciclovía/bicisenda ${share ? Math.round(share.bike * 100) + '%' : ''}`),
  h('span', {}, h('i', { style: { background: 'var(--calm)' } }), `Calles tranquilas ${share ? Math.round(share.calm * 100) + '%' : ''}`),
  h('span', {}, h('i', { style: { background: 'var(--road)' } }), `Avenidas ${share ? Math.round(share.road * 100) + '%' : ''}`));
const dots = (n) => h('span', { class: 'dots', title: `Entreno ${n}/5` }, '●'.repeat(n) + '○'.repeat(5 - n));
const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
const sectionH = (title, right) => h('div', { class: 'section-h' }, h('h2', {}, title), right || '');
const spinner = (txt = 'Cargando…') => h('div', { class: 'muted small' }, txt);

function actTitle(a) {
  if (a.title) return a.title;
  const hr = new Date(a.startedAt).getHours();
  const part = hr < 6 ? 'de madrugada' : hr < 12 ? 'a la mañana' : hr < 14 ? 'al mediodía' : hr < 20 ? 'a la tarde' : 'a la noche';
  return `${TYPES[a.type]?.label || 'Actividad'} ${a.source === 'legacy' ? '' : part}`.trim();
}

function actRow(a) {
  const T = TYPES[a.type] || TYPES.correr;
  const sec = a.movingS || a.durationS;
  const sub = [fmtDate(a.startedAt), fmtDuration(sec, false), a.type === 'bici' ? `${fmtSpeed(a.distanceKm, sec)} km/h` : `${fmtPace(a.distanceKm, sec)} /km`].join(' · ');
  return h('div', { class: 'act', onclick: () => go(`#/act/${a.id}`) },
    h('div', { class: 'e', style: { boxShadow: `inset 0 0 0 1px ${T.color}55` } }, T.emoji),
    h('div', { class: 'grow' }, h('div', { class: 't' }, actTitle(a)), h('div', { class: 's' }, sub)),
    h('div', { class: 'km' }, fmtKm(a.distanceKm || 0), h('div', { class: 'tiny muted' }, 'km')));
}

function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

// ======================= clima =======================
async function loadWeather(force = false) {
  if (!force && S.weather && Date.now() - S.wxAt < 10 * 60e3) return S.weather;
  const wx = await api(`/api/weather?lat=${S.home.lat}&lon=${S.home.lon}`);
  S.weather = summarizeWeather(wx); S.wxAt = Date.now();
  return S.weather;
}

async function routesWithData(list = CURATED) {
  const out = [];
  for (const r of list) out.push({ ...r, _data: await cachedRoute(r, S.home, S.profile) });
  return out;
}

let warming = false;
async function warmRoutes(onEach) {
  if (warming) return; warming = true;
  try {
    for (const r of CURATED) {
      if (await cachedRoute(r, S.home, S.profile)) continue;
      try { await computeRoute(r, S.home, S.profile); onEach?.(); } catch (e) { console.warn('ruta', r.id, e.message); }
    }
  } finally { warming = false; }
}

function windArrow(deg) {
  // la flecha apunta hacia donde VA el viento
  return h('span', { class: 'wind-arrow', style: { transform: `rotate(${(deg + 180) % 360}deg)` } }, '↑');
}

// ======================= vista: HOY =======================
async function viewHoy() {
  const acts = await store.listActivities();
  const now = new Date();
  const wk = periodTotals(acts, startOfWeek().getTime());
  const pending = Recorder.pending();

  const wxCard = h('div', { class: 'card' }, spinner('Consultando el clima…'));
  const recoCard = h('div', { class: 'card reco' }, spinner('Armando la recomendación…'));

  app.replaceChildren(
    h('div', { class: 'page-title' },
      h('div', {}, h('div', { class: 'brand' }, 'PEDAL BA'), h('h1', {}, cap(fmtDate(now, { weekday: 'long', day: 'numeric', month: 'long' })))),
      h('div', { class: 'sub' }, '🏠 ', S.home.label.split(',')[0])),
    pending ? h('div', { class: 'card tap', style: { borderColor: 'var(--warn)' }, onclick: () => go('#/grabar') },
      h('b', {}, '⏸ Tenés una grabación sin terminar'), h('div', { class: 'muted small' }, 'Tocá para seguirla o guardarla')) : '',
    wxCard, recoCard,
    sectionH('Esta semana', h('a', { href: '#/historial', class: 'small' }, 'Ver todo')),
    h('div', { class: 'card' },
      h('div', { class: 'stats' }, stat(fmtKm(wk.km), 'km'), stat(fmtDuration(wk.sec, false), 'en movimiento'), stat(String(wk.n), wk.n === 1 ? 'sesión' : 'sesiones')),
      h('div', { class: 'chips' }, ...Object.entries(wk.byType).map(([t, v]) => h('span', { class: 'chip' }, `${TYPES[t]?.emoji} ${fmtKm(v.km)} km`)))),
    acts.length ? sectionH('Últimas') : '',
    acts.length ? h('div', { class: 'card', style: { padding: '4px 16px' } }, ...acts.slice(0, 3).map(actRow)) : h('div', { class: 'card empty' }, 'Todavía no registraste nada. Tocá ● Grabar para tu primera salida.'),
  );

  let sw = null;
  try {
    sw = await loadWeather();
    const [wlabel, wemoji] = wxLabel(sw.code);
    wxCard.replaceChildren(
      h('div', { class: 'wx' },
        h('div', { class: 'emoji' }, wemoji),
        h('div', {},
          h('div', { class: 'row' }, h('div', { class: 'big' }, `${Math.round(sw.temp)}°`), h('div', { class: 'muted small' }, wlabel, h('br'), `Sensación ${Math.round(sw.feels)}° · máx ${Math.round(sw.max)}° / mín ${Math.round(sw.min)}°`)))),
      h('div', { class: 'chips' },
        h('span', { class: `chip ${sw.windAvg >= 25 ? 'warn' : ''}` }, windArrow(sw.windDir), ` Viento ${compass(sw.windDir)} ${Math.round(sw.windAvg)} km/h · ráfagas ${Math.round(sw.gustMax)}`),
        h('span', { class: `chip ${sw.precipProb >= 40 ? 'warn' : ''}` }, `💧 ${Math.round(sw.precipProb)}% próx. 3 h`),
        sw.sunset ? h('span', { class: 'chip' }, `🌇 ${fmtTime(sw.sunset)}`) : '',
        sw.uv >= 7 ? h('span', { class: 'chip warn' }, `UV ${Math.round(sw.uv)}`) : ''));
  } catch (e) {
    wxCard.replaceChildren(h('div', { class: 'muted small' }, `No pude traer el clima (${e.message}).`));
  }

  const paintReco = async () => {
    const rs = await routesWithData();
    const rec = recommend(sw, rs, S.home, new Date());
    const top = rec.ranked[0];
    recoCard.replaceChildren(
      h('div', { class: 'label' }, rec.mode === 'cinta' ? 'Plan B' : 'Recomendación de hoy'),
      h('h2', {}, rec.headline),
      h('ul', {}, ...rec.reasons.map(r => h('li', {}, r))),
      top && rec.mode !== 'cinta' ? h('div', { class: 'card tap', style: { marginTop: '12px', marginBottom: 0, background: 'var(--surface-2)' }, onclick: () => go(`#/ruta/${top.route.id}`) },
        h('div', { class: 'row between' }, h('b', {}, top.route.name), h('span', { class: 'muted small' }, top.route._data ? `${fmtKm(top.route._data.distanceKm)} km` : `~${top.route.approxKm} km`)),
        top.why.length ? h('div', { class: 'muted small' }, top.why.join(' · ')) : '',
        mixbar(top.route._data?.share)) : '',
      h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        rec.mode === 'cinta'
          ? h('a', { class: 'btn primary', href: '#/grabar?type=cinta' }, '🏋️ Cargar cinta')
          : h('a', { class: 'btn primary', href: top ? `#/grabar?route=${top.route.id}` : '#/grabar' }, '● Salir ahora'),
        h('a', { class: 'btn', href: '#/rutas' }, 'Ver todas las rutas')));
  };
  await paintReco();
  warmRoutes(() => { if (location.hash === '' || location.hash === '#/') paintReco(); });
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ======================= vista: RUTAS =======================
async function viewRutas() {
  const listEl = h('div', {});
  const mine = await store.listMyRoutes();
  const gen = await store.getSetting('genRoutes', []);
  gen.forEach(r => S.generated.set(r.id, r));

  const seg = h('div', { class: 'seg' }, ...Object.entries(PROFILES).map(([k, p]) =>
    h('button', { class: k === S.profile ? 'on' : '', title: p.hint, onclick: async () => { S.profile = k; await store.setSetting('profile', k); viewRutas(); } }, p.label)));

  const kmIn = h('input', { type: 'range', min: '15', max: '45', step: '1', value: '28', style: { width: '100%' } });
  const kmOut = h('b', {}, '28 km');
  kmIn.addEventListener('input', () => (kmOut.textContent = `${kmIn.value} km`));
  const dirSel = h('select', { class: 'input' },
    h('option', { value: 'auto' }, 'Automático: salir contra el viento'),
    ...[['0', 'Norte'], ['45', 'Noreste'], ['90', 'Este'], ['135', 'Sudeste'], ['180', 'Sur'], ['225', 'Sudoeste'], ['270', 'Oeste'], ['315', 'Noroeste']].map(([v, l]) => h('option', { value: v }, `Hacia el ${l.toLowerCase()}`)));

  const genCard = h('div', { class: 'card' },
    h('h3', {}, '🎲 Generar un loop a medida'),
    h('div', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Arma una vuelta desde tu casa priorizando ciclovías, con la distancia que quieras.'),
    h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Distancia'), kmOut), kmIn,
    h('label', { class: 'field', style: { marginTop: '10px' } }, h('span', { class: 'label' }, 'Dirección'), dirSel),
    h('button', { class: 'btn primary block', onclick: async () => {
      let brg = Number(dirSel.value);
      if (dirSel.value === 'auto') { try { const sw = await loadWeather(); brg = sw.windAvg >= 8 ? sw.windDir : Math.random() * 360; } catch { brg = Math.random() * 360; } }
      const r = makeLoop(S.home, Number(kmIn.value), brg);
      S.generated.set(r.id, r);
      const list = [r, ...gen.filter(x => x.id !== r.id)].slice(0, 8);
      await store.setSetting('genRoutes', list);
      go(`#/ruta/${r.id}`);
    } }, 'Generar ruta'));

  const importBtn = h('button', { class: 'btn block', onclick: () => pickFile('.gpx,application/gpx+xml,application/xml', async (text, name) => {
    const g = parseGPX(text);
    const pts = g.points.map(p => [p[0], p[1]]);
    const r = { id: 'mine-' + uid(), name: g.name || name.replace(/\.gpx$/i, ''), coords: pts, distanceKm: lengthKm(pts), source: 'gpx', training: 3, exposure: 0.5 };
    await store.saveMyRoute(r);
    toast('Ruta importada'); go(`#/ruta/${r.id}`);
  }) }, '⤵︎ Importar ruta GPX (Strava, Wikiloc, Komoot…)');

  app.replaceChildren(
    h('div', { class: 'page-title' }, h('h1', {}, 'Rutas'), h('div', { class: 'sub' }, '25–30 km desde casa')),
    seg, h('div', { class: 'muted tiny', style: { margin: '6px 2px 12px' } }, PROFILES[S.profile].hint),
    listEl,
    sectionH('A medida'), genCard,
    sectionH('Mis rutas'),
    ...(mine.length ? mine.map(r => routeCard(r, { coords: r.coords, distanceKm: r.distanceKm, share: r.share })) : [h('div', { class: 'muted small', style: { margin: '0 2px 10px' } }, 'Guardá rutas desde tus actividades o importá un GPX.')]),
    importBtn,
    h('p', { class: 'muted tiny', style: { marginTop: '18px' } }, 'Las rutas se calculan con BRouter sobre OpenStreetMap, que incluye la red de ciclovías y bicisendas de la Ciudad y de los municipios del norte. En el mapa podés activar la capa CyclOSM (resalta ciclovías) y la de rutas ciclistas señalizadas.'),
  );

  let sw = null; try { sw = await loadWeather(); } catch {}
  const paint = async () => {
    const rs = await routesWithData();
    const rec = recommend(sw, rs, S.home);
    listEl.replaceChildren(...rec.ranked.map((x, i) => routeCard(x.route, x.route._data, { best: i === 0 && rec.mode !== 'cinta', why: x.why })));
  };
  await paint();
  warmRoutes(() => { if (location.hash.startsWith('#/rutas')) paint(); });
}

function routeCard(r, data, { best = false, why = [] } = {}) {
  return h('div', { class: 'card tap route-card', onclick: () => go(`#/ruta/${r.id}`) },
    h('div', { class: 'row between' }, h('h3', { class: 'grow' }, r.name), best ? h('span', { class: 'badge' }, 'Hoy') : ''),
    r.tagline ? h('div', { class: 'muted small', style: { marginTop: '3px' } }, r.tagline) : '',
    mixbar(data?.share),
    h('div', { class: 'meta' },
      h('span', {}, h('b', {}, data ? fmtKm(data.distanceKm) : `~${r.approxKm || '?'}`), ' km'),
      data?.share ? h('span', {}, h('b', {}, `${Math.round(data.share.bike * 100)}%`), ' ciclovía') : '',
      r.training ? h('span', {}, 'Entreno ', dots(r.training)) : '',
      why.length ? h('span', {}, why[0]) : ''));
}

function findRoute(id) {
  return CURATED.find(r => r.id === id) || S.generated.get(id) || null;
}

// ======================= vista: DETALLE DE RUTA =======================
async function viewRuta(id) {
  let r = findRoute(id);
  if (!r) {
    const gen = await store.getSetting('genRoutes', []);
    gen.forEach(x => S.generated.set(x.id, x));
    r = findRoute(id) || (await store.get('routes', id));
  }
  if (!r || r.deleted) { app.replaceChildren(h('div', { class: 'empty' }, 'No encontré esa ruta.'), h('a', { class: 'btn block', href: '#/rutas' }, 'Volver')); return; }
  const isMine = Boolean(r.coords && !r.waypoints);

  const mapEl = h('div', { class: 'map tall' });
  const info = h('div', {}, h('div', { class: 'card' }, spinner('Calculando el recorrido por ciclovías…')));
  const seg = isMine ? '' : h('div', { class: 'seg', style: { marginBottom: '12px' } }, ...Object.entries(PROFILES).map(([k, p]) =>
    h('button', { class: k === S.profile ? 'on' : '', onclick: async () => { S.profile = k; await store.setSetting('profile', k); viewRuta(id); } }, p.label)));

  app.replaceChildren(
    h('div', { class: 'row', style: { margin: '4px 0 12px' } }, h('a', { class: 'icon-btn', href: '#/rutas', style: { display: 'grid', placeItems: 'center', textDecoration: 'none' } }, '←'), h('h1', { class: 'grow', style: { fontSize: '22px' } }, r.name)),
    seg, mapEl, info);
  clearMaps();
  const map = makeMap(mapEl);

  let data;
  try { data = await computeRoute(r, S.home, S.profile); }
  catch (e) {
    info.replaceChildren(h('div', { class: 'card' }, h('b', {}, 'No se pudo calcular la ruta'), h('div', { class: 'muted small' }, e.message),
      h('button', { class: 'btn block', style: { marginTop: '10px' }, onclick: () => viewRuta(id) }, 'Reintentar')));
    return;
  }
  drawRoute(map, data);

  let windTxt = '';
  try {
    const sw = await loadWeather();
    const out = outboundBearing(data.coords, S.home);
    const diff = angleDiff(out, sw.windDir);
    windTxt = sw.windAvg < 10 ? `Viento suave (${Math.round(sw.windAvg)} km/h): da igual el sentido.`
      : diff < 60 ? `Salís hacia el ${compassName(out)} con viento del ${compassName(sw.windDir)} (${Math.round(sw.windAvg)} km/h): ida en contra, vuelta a favor 👌`
      : diff > 120 ? `Ojo: con viento del ${compassName(sw.windDir)} (${Math.round(sw.windAvg)} km/h) la vuelta es en contra. Podés hacerla al revés.`
      : `Viento del ${compassName(sw.windDir)} de costado (${Math.round(sw.windAvg)} km/h).`;
  } catch {}

  const item = { type: 'ruta', title: r.name, points: data.coords, distanceKm: data.distanceKm, share: data.share, ascentM: data.ascentM };
  info.replaceChildren(
    h('div', { class: 'card' },
      h('div', { class: 'stats' }, stat(fmtKm(data.distanceKm), 'km'), stat(`${data.ascentM || 0} m`, 'desnivel'), stat(data.share ? `${Math.round(data.share.bike * 100)}%` : '—', 'ciclovía')),
      mixbar(data.share), legend(data.share),
      data.share?.unpaved > 0.05 ? h('div', { class: 'notice', style: { marginTop: '10px' } }, `${Math.round(data.share.unpaved * 100)}% sin asfaltar según OpenStreetMap.`) : ''),
    windTxt ? h('div', { class: 'card small' }, '🌬️ ', windTxt) : '',
    r.tips ? h('div', { class: 'card small' }, '💡 ', r.tips) : '',
    h('a', { class: 'btn primary block', href: `#/grabar?route=${encodeURIComponent(r.id)}`, style: { marginBottom: '8px' } }, '🧭 Navegar y grabar esta ruta'),
    h('div', { class: 'btn-row three' },
      h('a', { class: 'btn', href: googleMapsLink(data.coords.map(c => [c[0], c[1]])), target: '_blank', rel: 'noopener' }, 'Google Maps'),
      h('button', { class: 'btn', onclick: () => download(new Blob([toGPX({ name: r.name, points: data.coords.map(c => [c[0], c[1], null, c[2]]) })], { type: 'application/gpx+xml' }), `${slug(r.name)}.gpx`) }, 'GPX'),
      h('button', { class: 'btn', onclick: () => openShare(item) }, 'Compartir')),
    isMine ? h('button', { class: 'btn danger block', style: { marginTop: '8px' }, onclick: async () => { if (confirm('¿Borrar esta ruta?')) { await store.deleteMyRoute(r.id); go('#/rutas'); } } }, 'Borrar ruta') :
      h('button', { class: 'btn block', style: { marginTop: '8px' }, onclick: async () => { await computeRoute(r, S.home, S.profile, { force: true }); viewRuta(id); } }, '↻ Recalcular'),
  );
}

// ======================= vista: GRABAR =======================
let REC = null;

async function viewGrabar(params) {
  const pending = Recorder.pending();
  if (pending && !REC) {
    app.replaceChildren(
      h('div', { class: 'page-title' }, h('h1', {}, 'Grabación pendiente')),
      h('div', { class: 'card' },
        h('p', {}, `${typeLabel(pending.type)} empezada a las ${fmtTime(pending.startedAt)} con ${pending.points.length} puntos GPS.`),
        h('button', { class: 'btn primary block', onclick: () => { const r = new Recorder({ type: pending.type, voice: S.voice, keepScreen: S.keepScreen }); r.restore(pending); startLive(r, pending.routeId); } }, '▶ Seguir grabando'),
        h('button', { class: 'btn block', style: { marginTop: '8px' }, onclick: async () => { const r = new Recorder({ type: pending.type }); r.restore(pending); await finishRecording(r); } }, '✓ Guardarla así'),
        h('button', { class: 'btn danger block', style: { marginTop: '8px' }, onclick: () => { if (confirm('¿Descartar la grabación?')) { Recorder.clearPending(); viewGrabar(params); } } }, 'Descartar')));
    return;
  }

  let type = params.get('type') || (await store.getSetting('lastType', 'bici'));
  const routeId = params.get('route');
  const route = routeId ? (findRoute(routeId) || (await store.get('routes', routeId))) : null;
  const body = h('div', {});

  const grid = h('div', { class: 'type-grid' }, ...Object.entries(TYPES).map(([k, T]) =>
    h('button', { class: `type-btn ${k === type ? 'on' : ''}`, onclick: () => { type = k; store.setSetting('lastType', k); paint(); } },
      h('div', { class: 'e' }, T.emoji), h('div', { class: 't' }, T.label),
      h('div', { class: 'd' }, k === 'cinta' ? 'Carga manual' : 'Con GPS'))));

  const paint = () => {
    [...grid.children].forEach((b, i) => b.classList.toggle('on', Object.keys(TYPES)[i] === type));
    if (type === 'cinta') { body.replaceChildren(manualForm('cinta')); return; }
    const voice = h('input', { type: 'checkbox', checked: S.voice });
    voice.addEventListener('change', () => { S.voice = voice.checked; store.setSetting('voice', voice.checked); });
    const awake = h('input', { type: 'checkbox', checked: S.keepScreen });
    awake.addEventListener('change', () => { S.keepScreen = awake.checked; store.setSetting('keepScreen', awake.checked); });
    body.replaceChildren(
      route ? h('div', { class: 'card small' }, '🧭 Navegando: ', h('b', {}, route.name), ' ', h('a', { href: '#/grabar' }, 'quitar')) : '',
      isNative
        ? h('div', { class: 'card small', style: { margin: '12px 0' } }, '📍 Podés bloquear el celu o usar otras apps: el GPS sigue grabando y vas a ver una notificación fija mientras dure la actividad.')
        : h('div', { class: 'notice', style: { margin: '12px 0' } }, 'Dejá la app abierta con la pantalla prendida (la mantengo encendida yo). Si bloqueás el celu o cambiás de app, el navegador corta el GPS y ese tramo queda en línea recta. La app de Android no tiene esta limitación (Más → App Android).'),
      h('label', { class: 'row small', style: { margin: '6px 2px 8px' } }, voice, route ? 'Voz: indicaciones de giro y aviso en cada km' : 'Voz: aviso en cada kilómetro'),
      h('label', { class: 'row small', style: { margin: '0 2px 14px' } }, awake, 'Mantener la pantalla encendida mientras grabo'),
      route ? '' : h('div', { class: 'muted tiny', style: { margin: '-6px 2px 14px' } }, 'Para tener indicaciones de giro, elegí una ruta en la pestaña Rutas y tocá “Navegar y grabar”.'),
      h('button', { class: 'btn primary block', style: { padding: '18px', fontSize: '17px' }, onclick: () => startLive(new Recorder({ type, routeId, voice: S.voice, keepScreen: S.keepScreen }), routeId) }, route ? `▶ Navegar y grabar` : `▶ Empezar ${TYPES[type].label.toLowerCase()}`),
      h('details', { style: { marginTop: '18px' } }, h('summary', { class: 'muted small' }, 'Me olvidé de grabar: cargar a mano'), h('div', { style: { marginTop: '10px' } }, manualForm(type))),
    );
  };

  app.replaceChildren(h('div', { class: 'page-title' }, h('h1', {}, 'Grabar')), grid, body);
  paint();
}

function manualForm(type) {
  const date = h('input', { class: 'input', type: 'date', value: todayISO() });
  const time = h('input', { class: 'input', type: 'time', value: new Date().toTimeString().slice(0, 5) });
  const dist = h('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'Ej: 6,25' });
  const dur = h('input', { class: 'input', type: 'text', inputmode: 'numeric', placeholder: 'Ej: 45:00 o 1:05:00' });
  const incl = h('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'Opcional' });
  const notes = h('textarea', { class: 'input', placeholder: 'Calorías, FC, sensaciones…' });
  const live = h('div', { class: 'muted small', style: { margin: '-4px 2px 12px' } });
  const upd = () => {
    const km = Number(dist.value.replace(',', '.')), sec = parseDuration(dur.value);
    live.textContent = km > 0 && sec > 0 ? `Velocidad ${fmtSpeed(km, sec)} km/h · ritmo ${fmtPace(km, sec)} /km` : '';
  };
  dist.addEventListener('input', upd); dur.addEventListener('input', upd);
  return h('div', { class: 'card' },
    h('div', { class: 'btn-row' }, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Fecha'), date), h('label', { class: 'field' }, h('span', { class: 'label' }, 'Hora'), time)),
    h('div', { class: 'btn-row' }, h('label', { class: 'field' }, h('span', { class: 'label' }, 'Distancia (km)'), dist), h('label', { class: 'field' }, h('span', { class: 'label' }, 'Duración'), dur)),
    live,
    type === 'cinta' ? h('label', { class: 'field' }, h('span', { class: 'label' }, 'Inclinación (%)'), incl) : '',
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Notas'), notes),
    h('button', { class: 'btn primary block', onclick: async () => {
      const km = Number(dist.value.replace(',', '.')), sec = parseDuration(dur.value);
      if (!(km > 0) || !(sec > 0)) { toast('Completá distancia y duración'); return; }
      const startedAt = new Date(`${date.value}T${time.value || '08:00'}:00`).getTime();
      const a = await store.saveActivity({
        id: uid(), type, source: 'manual', title: '', date: date.value, startedAt,
        durationS: sec, movingS: sec, distanceKm: km, avgKmh: km / (sec / 3600),
        inclinePct: incl.value ? Number(incl.value.replace(',', '.')) : undefined, notes: notes.value.trim(),
      });
      toast('Guardado ✓'); go(`#/act/${a.id}`);
    } }, 'Guardar'));
}

async function startLive(rec, routeId) {
  REC = rec;
  const T = TYPES[rec.type];
  const mapEl = h('div', { class: 'map' });
  const v = { time: h('div', { class: 'v' }, '0:00'), dist: h('div', { class: 'v' }, '0,00'), a: h('div', { class: 'v sm' }, '—'), b: h('div', { class: 'v sm' }, '—') };
  const status = h('div', { class: 'live-status' }, h('span', { class: 'gps-dot' }), h('span', {}, 'Buscando GPS…'));
  const pauseBtn = h('button', { class: 'btn' }, '⏸ Pausa');
  const stopBtn = h('button', { class: 'btn primary' }, '■ Terminar');
  const navArrow = h('div', { class: 'nav-arrow' }), navDist = h('div', { class: 'nav-dist' }), navText = h('div', { class: 'nav-text' });
  const navBanner = h('div', { class: 'nav-banner', style: { display: 'none' } }, navArrow, h('div', { class: 'grow' }, navDist, navText));
  const muteBtn = h('button', { class: 'nav-mute', 'aria-label': 'Sonido', onclick: () => {
    rec.voice = !rec.voice; S.voice = rec.voice; store.setSetting('voice', rec.voice);
    muteBtn.textContent = rec.voice ? '🔊' : '🔇';
    toast(rec.voice ? 'Voz activada' : 'Voz silenciada');
    if (rec.voice) speak('Voz activada.');
  } }, rec.voice ? '🔊' : '🔇');
  const live = h('div', { class: 'live' }, navBanner, mapEl,
    h('div', { class: 'live-panel' }, status,
      h('div', { class: 'live-main' },
        h('div', {}, v.time, h('div', { class: 'l' }, 'tiempo')),
        h('div', {}, v.dist, h('div', { class: 'l' }, 'km')),
        h('div', {}, v.a, h('div', { class: 'l' }, T.speed ? 'km/h ahora' : 'ritmo /km')),
        h('div', {}, v.b, h('div', { class: 'l' }, T.speed ? 'km/h promedio' : 'ritmo actual'))),
      h('div', { class: 'btn-row' }, pauseBtn, stopBtn)));
  document.body.append(live);
  $('#tabs').style.display = 'none';

  const map = L.map(mapEl, { zoomControl: false }).setView([S.home.lat, S.home.lon], 16);
  BASES['Claro']().addTo(map);
  let nav = null;
  if (routeId) {
    const r = findRoute(routeId) || (await store.get('routes', routeId));
    if (r) {
      try {
        const data = await computeRoute(r, S.home, S.profile);
        drawRoute(map, data, { fit: false });
        nav = new Navigator(data, { mode: rec.type === 'bici' ? 'bici' : 'pie', say: (t) => { if (rec.voice) speak(t, { flush: true }); } });
        navBanner.style.display = '';
        navDist.textContent = 'Buscando GPS…';
        navText.textContent = r.name;
      } catch (e) { toast('No pude cargar la ruta para navegar'); }
    }
  }
  const paintNav = (st) => {
    if (!st) return;
    navBanner.classList.toggle('off', !!st.off);
    if (st.off) {
      navArrow.innerHTML = '<svg viewBox="0 0 48 48"><path d="M24 6L44 42H4z" fill="currentColor"/><path d="M24 18v12M24 35v2" stroke="#000" stroke-width="4" stroke-linecap="round"/></svg>';
      navDist.textContent = Number.isFinite(st.offDist) ? `A ${spokenDistance(st.offDist)}` : 'Fuera de ruta';
      navText.textContent = st.along ? 'Te saliste de la ruta' : 'Andá hasta el inicio de la ruta';
      return;
    }
    if (!st.next) return;
    navArrow.innerHTML = arrowSvg(st.next);
    navDist.textContent = st.dist >= 1000 ? `${fmtNum(st.dist / 1000, 1)} km` : `${Math.max(0, Math.round(st.dist / 10) * 10)} m`;
    navText.textContent = st.text + (st.total ? ` · faltan ${fmtNum(Math.max(0, st.total - st.along) / 1000, 1)} km` : '');
  };
  rec.onFix = (lat, lon, kmh) => { if (nav && rec.state === 'running') paintNav(nav.update(lat, lon, kmh)); };
  const line = L.polyline(rec.points.map(p => [p[0], p[1]]), { color: T.color === '#c6f432' ? '#65a30d' : T.color, weight: 6 }).addTo(map);
  const me = L.marker([S.home.lat, S.home.lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
  let follow = true;
  map.on('dragstart', () => { follow = false; });
  const ctrls = L.control({ position: 'bottomright' });
  ctrls.onAdd = () => {
    const box = h('div', { class: 'live-ctrls' },
      muteBtn,
      h('button', { class: 'nav-mute', 'aria-label': 'Centrar', onclick: (e) => { e.stopPropagation(); follow = true; const p = rec.points[rec.points.length - 1]; if (p) map.setView([p[0], p[1]], nav ? 17 : 16); } }, '◎'));
    L.DomEvent.disableClickPropagation(box);
    return box;
  };
  ctrls.addTo(map);

  let lastN = rec.points.length;
  rec.onUpdate = (r) => {
    const el = r.elapsedS(), km = r.distM / 1000;
    v.time.textContent = fmtDuration(el);
    v.dist.textContent = fmtNum(km, 2);
    if (T.speed) { v.a.textContent = fmtNum(r.curKmh || 0, 1); v.b.textContent = el > 5 ? fmtNum(km / (el / 3600), 1) : '—'; }
    else { v.a.textContent = fmtPace(km, el); v.b.textContent = r.curKmh > 1 ? fmtPace(1, 3600 / r.curKmh) : '—'; }
    const acc = r.accuracy;
    status.children[0].className = `gps-dot ${acc == null ? '' : acc <= 15 ? 'ok' : 'meh'}`;
    status.children[1].textContent = r.error || (r.state === 'paused' ? 'En pausa' : acc == null ? 'Buscando GPS…' : `GPS ±${Math.round(acc)} m · ${r.points.length} puntos`);
    if (r.points.length !== lastN) {
      lastN = r.points.length;
      const p = r.points[r.points.length - 1];
      line.addLatLng([p[0], p[1]]); me.setLatLng([p[0], p[1]]);
      if (follow) map.setView([p[0], p[1]], map.getZoom() < 14 ? (nav ? 17 : 16) : map.getZoom(), { animate: true });
    }
  };
  pauseBtn.onclick = async () => {
    if (rec.state === 'running') { rec.pause(); pauseBtn.textContent = '▶ Seguir'; }
    else { await rec.start(); pauseBtn.textContent = '⏸ Pausa'; }
  };
  stopBtn.onclick = async () => {
    if (rec.points.length < 2 && !confirm('Casi no hay recorrido grabado. ¿Terminar igual?')) return;
    if (rec.points.length >= 2 && !confirm('¿Terminar y guardar?')) return;
    await finishRecording(rec);
  };
  try { await rec.start(); } catch (e) { toast(e.message); }
}

async function finishRecording(rec) {
  await rec.stop();
  document.querySelector('.live')?.remove();
  $('#tabs').style.display = '';
  REC = null;
  if (rec.points.length < 2) { toast('No se guardó: no hubo recorrido'); go('#/'); return; }
  const st = computeStats(rec.points, rec.type);
  const route = rec.routeId ? (findRoute(rec.routeId) || null) : null;
  const a = await store.saveActivity({
    id: uid(), type: rec.type, source: 'gps', title: route ? route.name : '',
    date: todayISO(new Date(rec.startedAt)), startedAt: rec.startedAt, routeId: rec.routeId || null,
    points: rec.points, ...st, durationS: Math.round(rec.elapsedS()) || st.durationS, notes: '',
  });
  toast('¡Actividad guardada! 💪');
  go(`#/act/${a.id}`);
}

// ======================= vista: HISTORIAL =======================
async function viewHistorial(params) {
  const acts = await store.listActivities();
  const period = params.get('p') || 'semana';
  const filter = params.get('t') || '';
  const now = new Date();
  const from = period === 'semana' ? startOfWeek(now).getTime()
    : period === 'mes' ? new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    : period === 'año' ? new Date(now.getFullYear(), 0, 1).getTime() : 0;
  const filtered = filter ? acts.filter(a => a.type === filter) : acts;
  const tot = periodTotals(filtered, from);
  const weeks = weeklySeries(filtered, 12);
  const maxW = Math.max(1, ...weeks.map(w => w.km));

  const link = (p, t) => `#/historial?p=${p}${t ? '&t=' + t : ''}`;
  const groups = new Map();
  for (const a of filtered) {
    const k = new Date(a.startedAt).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }

  app.replaceChildren(
    h('div', { class: 'page-title' }, h('h1', {}, 'Historial'), h('div', { class: 'sub' }, `${acts.length} sesiones`)),
    h('div', { class: 'seg', style: { marginBottom: '10px' } }, ...['semana', 'mes', 'año', 'todo'].map(p => h('button', { class: p === period ? 'on' : '', onclick: () => go(link(p, filter)) }, cap(p)))),
    h('div', { class: 'chips', style: { margin: '0 0 12px' } },
      h('a', { class: 'chip', href: link(period, ''), style: { textDecoration: 'none', color: filter ? 'var(--muted)' : 'var(--text)' } }, 'Todo'),
      ...Object.entries(TYPES).map(([k, T]) => h('a', { class: 'chip', href: link(period, k), style: { textDecoration: 'none', color: filter === k ? 'var(--text)' : 'var(--muted)', borderColor: filter === k ? T.color : '' } }, `${T.emoji} ${T.label}`))),
    h('div', { class: 'card' },
      h('div', { class: 'stats' }, stat(fmtKm(tot.km), 'km'), stat(fmtDuration(tot.sec, false), 'tiempo'), stat(String(tot.n), 'sesiones')),
      h('div', { class: 'chips' }, ...Object.entries(tot.byType).map(([t, x]) => h('span', { class: 'chip' }, `${TYPES[t]?.emoji} ${fmtKm(x.km)} km · ${x.n}`)))),
    h('div', { class: 'card' },
      h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Km por semana (últimas 12)'),
      h('div', { class: 'chart' }, ...weeks.map(w => {
        const parts = Object.entries(w.byType).filter(([, km]) => km > 0);
        return h('div', { class: 'col', title: `${fmtKm(w.km)} km` }, ...parts.map(([t, km], i) => h('span', { class: i === parts.length - 1 ? 'top' : '', style: { height: `${(km / maxW) * 100}%`, background: TYPES[t].color } })));
      })),
      h('div', { class: 'chart-labels' }, ...weeks.map(w => h('span', {}, `${w.from.getDate()}/${w.from.getMonth() + 1}`)))),
    ...(filtered.length ? [...groups].map(([k, list]) => h('div', {},
      sectionH(cap(k), h('span', { class: 'muted small' }, `${fmtKm(list.reduce((s, a) => s + (a.distanceKm || 0), 0))} km`)),
      h('div', { class: 'card', style: { padding: '4px 16px' } }, ...list.map(actRow)))) : [h('div', { class: 'card empty' }, 'Sin actividades todavía.')]),
  );
}

// ======================= vista: ACTIVIDAD =======================
async function viewAct(id) {
  const a = await store.get('activities', id);
  if (!a || a.deleted) { app.replaceChildren(h('div', { class: 'empty' }, 'No encontré esa actividad.'), h('a', { class: 'btn block', href: '#/historial' }, 'Volver')); return; }
  const T = TYPES[a.type] || TYPES.correr;
  const sec = a.movingS || a.durationS;
  const hasMap = a.points?.length > 1;
  const mapEl = hasMap ? h('div', { class: 'map tall' }) : null;
  const title = h('h1', { class: 'grow', style: { fontSize: '22px' } }, actTitle(a));

  const maxSplit = a.splits?.length ? Math.max(...a.splits.map(s => s.sec)) : 1;
  app.replaceChildren(
    h('div', { class: 'row', style: { margin: '4px 0 6px' } }, h('a', { class: 'icon-btn', href: '#/historial', style: { display: 'grid', placeItems: 'center', textDecoration: 'none' } }, '←'), title,
      h('button', { class: 'icon-btn', 'aria-label': 'Editar', onclick: () => editAct(a) }, '✎')),
    h('div', { class: 'row muted small', style: { marginBottom: '12px' } }, h('span', { class: 'type-pill', style: { color: T.color } }, `${T.emoji} ${T.label}`),
      cap(fmtDate(a.startedAt, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })), a.source !== 'legacy' ? `· ${fmtTime(a.startedAt)}` : ''),
    mapEl || '',
    h('div', { class: 'card' },
      h('div', { class: 'stats' },
        stat(fmtKm(a.distanceKm || 0), 'km'),
        stat(fmtDuration(sec), a.movingS && a.movingS !== a.durationS ? 'en movimiento' : 'tiempo'),
        a.type === 'bici' ? stat(fmtSpeed(a.distanceKm, sec), 'km/h prom.') : stat(fmtPace(a.distanceKm, sec), 'ritmo /km'),
        a.maxKmh ? stat(fmtNum(a.maxKmh, 1), 'km/h máx.') : '',
        a.type !== 'bici' && a.distanceKm ? stat(fmtSpeed(a.distanceKm, sec), 'km/h prom.') : '',
        a.durationS && a.movingS && a.durationS - a.movingS > 60 ? stat(fmtDuration(a.durationS), 'tiempo total') : '',
        a.ascentM ? stat(`${a.ascentM} m`, 'desnivel') : '',
        a.inclinePct != null ? stat(`${fmtNum(a.inclinePct, 1)}%`, 'inclinación') : '')),
    a.notes ? h('div', { class: 'card small', style: { whiteSpace: 'pre-wrap' } }, a.notes) : '',
    a.splits?.length ? h('div', { class: 'card' }, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Parciales por km'),
      h('table', { class: 'splits' }, ...a.splits.map(s => h('tr', {},
        h('td', { style: { width: '40px' } }, s.km),
        h('td', { style: { width: '90px' } }, a.type === 'bici' ? `${fmtNum(3600 / s.sec, 1)} km/h` : fmtPace(1, s.sec)),
        h('td', {}, h('div', { class: 'bar', style: { width: `${(1 - (s.sec / maxSplit) * 0.6) * 100}%`, background: T.color } })))))) : '',
    hasMap ? h('button', { class: 'btn primary block', style: { marginBottom: '8px' }, onclick: () => openShare(a) }, '↗ Compartir (imagen, GIF o video)') : '',
    h('div', { class: 'btn-row' },
      hasMap ? h('button', { class: 'btn', onclick: () => download(new Blob([toGPX({ name: actTitle(a), type: a.type, points: a.points, startedAt: a.startedAt })], { type: 'application/gpx+xml' }), `${slug(actTitle(a))}-${a.date}.gpx`) }, 'Exportar GPX') : '',
      hasMap ? h('button', { class: 'btn', onclick: async () => {
        const name = prompt('Nombre de la ruta', actTitle(a)); if (!name) return;
        const pts = a.points.map(p => [p[0], p[1]]);
        const r = await store.saveMyRoute({ id: 'mine-' + uid(), name, coords: pts, distanceKm: a.distanceKm, source: 'activity', training: 3, exposure: 0.5 });
        toast('Ruta guardada'); go(`#/ruta/${r.id}`);
      } }, 'Guardar como ruta') : '',
      h('button', { class: 'btn danger', onclick: async () => { if (confirm('¿Borrar esta actividad?')) { await store.deleteActivity(a.id); toast('Borrada'); go('#/historial'); } } }, 'Borrar')),
  );
  if (hasMap) { clearMaps(); const map = makeMap(mapEl, { base: 'Claro' }); drawTrack(map, a.points, T.color === '#c6f432' ? '#65a30d' : T.color); }
}

function editAct(a) {
  const title = h('input', { class: 'input', value: a.title || actTitle(a) });
  const type = h('select', { class: 'input' }, ...Object.entries(TYPES).map(([k, T]) => h('option', { value: k, selected: k === a.type }, `${T.emoji} ${T.label}`)));
  const notes = h('textarea', { class: 'input' }); notes.value = a.notes || '';
  const s = sheet('Editar actividad', h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Título'), title),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Tipo'), type),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Notas'), notes),
    h('button', { class: 'btn primary block', onclick: async () => {
      a.title = title.value.trim(); a.type = type.value; a.notes = notes.value.trim();
      await store.saveActivity(a); s.close(); viewAct(a.id);
    } }, 'Guardar')));
}

// ======================= compartir =======================
async function openShare(item) {
  const shareMod = await import('./share.js');
  const it = { ...item, title: item.title || actTitle(item) };
  const out = h('div', {});
  const bar = h('div', { class: 'progress', style: { display: 'none' } }, h('span', {}));
  let busy = false;
  const run = async (kind) => {
    if (busy) return; busy = true;
    bar.style.display = ''; bar.firstChild.style.width = '5%';
    out.replaceChildren(spinner(kind === 'video' ? 'Grabando la animación (≈10 s)…' : kind === 'gif' ? 'Armando el GIF…' : 'Dibujando…'));
    try {
      const prog = (p) => (bar.firstChild.style.width = `${Math.round(p * 100)}%`);
      const blob = kind === 'img' ? await shareMod.makeImage(it) : kind === 'gif' ? await shareMod.makeGif(it, prog) : await shareMod.makeVideo(it, prog);
      bar.firstChild.style.width = '100%';
      const ext = kind === 'img' ? 'png' : kind === 'gif' ? 'gif' : (blob.type.includes('mp4') ? 'mp4' : 'webm');
      const name = `${slug(it.title)}-${it.date || todayISO()}.${ext}`;
      const url = URL.createObjectURL(blob);
      out.replaceChildren(
        kind === 'video' ? h('video', { class: 'preview', src: url, controls: true, autoplay: true, loop: true, muted: true, playsinline: true }) : h('img', { class: 'preview', src: url, alt: 'Vista previa' }),
        h('button', { class: 'btn primary block', onclick: () => shareOrDownload(blob, name, it.title) }, navigator.canShare ? '↗ Compartir' : '⬇ Descargar'),
        h('div', { class: 'muted tiny', style: { marginTop: '6px', textAlign: 'center' } }, `${(blob.size / 1024 / 1024).toFixed(1)} MB · ${ext.toUpperCase()}`));
    } catch (e) {
      out.replaceChildren(h('div', { class: 'notice' }, `No se pudo generar: ${e.message}`));
    } finally { busy = false; }
  };
  sheet('Compartir recorrido', h('div', {},
    h('div', { class: 'btn-row three', style: { marginBottom: '10px' } },
      h('button', { class: 'btn', onclick: () => run('img') }, '🖼️ Imagen'),
      h('button', { class: 'btn', onclick: () => run('gif') }, '🎞️ GIF'),
      h('button', { class: 'btn', disabled: !shareMod.videoSupported(), onclick: () => run('video') }, '🎬 Video')),
    bar, out));
  run('img');
}

// ======================= vista: MÁS =======================
async function viewMas() {
  const token = await store.getSetting('syncToken', '');
  const lastOk = await store.getSetting('lastSyncOk', 0);
  let health = null; try { health = await api('/api/health'); } catch {}

  const q = h('input', { class: 'input', placeholder: 'Buscar dirección (ej: Chorroarín 530)' });
  const results = h('div', {});
  const doSearch = async () => {
    results.replaceChildren(spinner('Buscando…'));
    try {
      const rs = await api(`/api/geocode?q=${encodeURIComponent(q.value)}`);
      results.replaceChildren(...(rs.length ? rs.map(r => h('div', { class: 'act', onclick: () => setHome({ label: r.name.split(',').slice(0, 3).join(','), lat: r.lat, lon: r.lon }) }, h('div', { class: 'grow small' }, r.name))) : [h('div', { class: 'muted small' }, 'Sin resultados')]));
    } catch (e) { results.replaceChildren(h('div', { class: 'muted small' }, e.message)); }
  };
  q.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  const tokenIn = h('input', { class: 'input', type: 'password', value: token, placeholder: 'Clave de sincronización', autocomplete: 'off' });
  const syncStatus = h('div', { class: 'muted small', style: { marginTop: '8px' } },
    !health?.sync ? 'El servidor no tiene la sincronización activada.' : token ? (lastOk ? `Última sincronización: ${fmtDate(lastOk)} ${fmtTime(lastOk)}` : 'Configurada, todavía sin sincronizar.') : 'Sin configurar: tus datos viven solo en este celular.');

  const voice = h('input', { type: 'checkbox', checked: S.voice });
  voice.addEventListener('change', () => { S.voice = voice.checked; store.setSetting('voice', voice.checked); });
  const awakeIn = h('input', { type: 'checkbox', checked: S.keepScreen });
  awakeIn.addEventListener('change', () => { S.keepScreen = awakeIn.checked; store.setSetting('keepScreen', awakeIn.checked); });

  app.replaceChildren(
    h('div', { class: 'page-title' }, h('h1', {}, 'Más')),
    h('div', { class: 'card' }, h('h3', {}, '🏠 Desde dónde salís'), h('div', { class: 'muted small', style: { margin: '4px 0 10px' } }, S.home.label),
      h('div', { class: 'row' }, q, h('button', { class: 'btn', onclick: doSearch }, 'Buscar')), results,
      h('button', { class: 'btn block', style: { marginTop: '8px' }, onclick: () => {
        navigator.geolocation.getCurrentPosition(p => setHome({ label: 'Mi ubicación', lat: p.coords.latitude, lon: p.coords.longitude }), () => toast('No pude obtener tu ubicación'), { enableHighAccuracy: true, timeout: 15000 });
      } }, '📍 Usar mi ubicación actual')),
    h('div', { class: 'card' }, h('h3', {}, '☁️ Sincronización'),
      h('div', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Con la clave, tus actividades se guardan también en tu servidor y las ves desde cualquier dispositivo.'),
      tokenIn,
      h('div', { class: 'btn-row', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary', onclick: async () => {
          await store.setSetting('syncToken', tokenIn.value.trim());
          try { const r = await store.sync({ full: true }); toast(r.skipped ? 'Guardado' : `Sincronizado: ↑${r.pushed} ↓${r.pulled}`); viewMas(); } catch (e) { toast(e.message); }
        } }, 'Guardar y sincronizar'),
        h('button', { class: 'btn', onclick: async () => { try { const r = await store.sync(); toast(r.skipped ? 'Sin clave configurada' : `↑${r.pushed} ↓${r.pulled}`); viewMas(); } catch (e) { toast(e.message); } } }, 'Sincronizar ahora')),
      syncStatus),
    androidCard(),
    h('div', { class: 'card' }, h('h3', {}, '⚙️ Preferencias'),
      h('label', { class: 'row small', style: { marginTop: '10px' } }, voice, 'Voz al grabar (giros y kilómetros)'),
      h('label', { class: 'row small', style: { marginTop: '10px' } }, awakeIn, 'Pantalla siempre encendida mientras grabo'),
      h('button', { class: 'btn block', style: { marginTop: '12px' }, onclick: async () => {
        const ok = await speak('En 200 metros, doblá a la derecha.');
        if (!ok) toast('No encontré una voz en el celular. Instalá “Servicios de voz de Google” desde Play Store.');
      } }, '🔊 Probar la voz')),
    h('div', { class: 'card' }, h('h3', {}, '📦 Datos'),
      h('div', { class: 'stack', style: { marginTop: '10px' } },
        h('button', { class: 'btn block', onclick: () => pickFile('.json,application/json', async (text) => {
          const n = await store.importBackup(JSON.parse(text)); toast(`${n} registros importados`);
        }) }, '⤵︎ Importar backup o JSON del Training Log viejo'),
        h('button', { class: 'btn block', onclick: () => pickFile('.gpx,application/gpx+xml,application/xml', async (text, name) => {
          const g = parseGPX(text);
          const type = g.type || prompt('¿Qué tipo de actividad? (bici, correr, caminar)', 'bici') || 'bici';
          const st = g.points.some(p => p[2] != null) ? computeStats(g.points, type) : { distanceKm: lengthKm(g.points), durationS: 0, movingS: 0 };
          const a = await store.saveActivity({ id: uid(), type: TYPES[type] ? type : 'bici', source: 'gpx', title: g.name || name.replace(/\.gpx$/i, ''), startedAt: g.startedAt || Date.now(), date: todayISO(new Date(g.startedAt || Date.now())), points: g.points, ...st, notes: '' });
          toast('Actividad importada'); go(`#/act/${a.id}`);
        }) }, '⤵︎ Importar actividad GPX (reloj, Strava…)'),
        h('button', { class: 'btn block', onclick: async () => download(new Blob([JSON.stringify(await store.exportAll())], { type: 'application/json' }), `pedal-ba-backup-${todayISO()}.json`) }, '⬇ Exportar backup completo'))),
    h('div', { class: 'card small muted' },
      h('b', { style: { color: 'var(--text)' } }, 'De dónde salen los datos'),
      h('p', {}, 'Ruteo: BRouter sobre OpenStreetMap (incluye ciclovías y bicisendas mapeadas de CABA y zona norte). Clima: Open-Meteo. Mapas: CyclOSM, CARTO y Waymarked Trails. Direcciones: Nominatim.'),
      h('p', {}, 'Para grabar con el GPS la app tiene que estar abierta: los navegadores no dejan usar la ubicación en segundo plano.')),
  );
}

function androidCard() {
  if (!isNative) {
    return h('div', { class: 'card' }, h('h3', {}, '🤖 App Android'),
      h('div', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Graba con la pantalla apagada y el celu en el bolsillo. Bajá el APK e instalalo (Android te va a pedir permitir apps de origen desconocido).'),
      h('a', { class: 'btn primary block', href: APK_URL }, '⬇ Descargar Pedal BA para Android'));
  }
  const info = h('div', { class: 'muted small', style: { margin: '4px 0 10px' } }, 'Consultando versión…');
  const card = h('div', { class: 'card' }, h('h3', {}, '🤖 App Android'), info,
    h('button', { class: 'btn block', onclick: () => checkUpdate(false) }, 'Buscar actualización'));
  currentBuild().then(b => { info.textContent = `Versión instalada: ${b || 'desarrollo'}`; });
  return card;
}

async function checkUpdate(silent) {
  try {
    const [cur, last] = await Promise.all([currentBuild(), latestBuild()]);
    if (last > cur && cur > 0) {
      if (confirm(`Hay una versión nueva de Pedal BA (${last}). ¿La bajo ahora? Tus datos se mantienen.`)) openExternal(APK_URL);
    } else if (!silent) toast('Tenés la última versión');
  } catch (e) { if (!silent) toast(e.message); }
}

async function setHome(home) {
  S.home = home; await store.setSetting('home', home);
  S.weather = null; toast('Casa actualizada'); viewMas();
}

// ======================= varios =======================
function pickFile(accept, cb) {
  const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return;
    try { await cb(await f.text(), f.name); } catch (e) { toast(e.message); }
    inp.remove();
  });
  document.body.append(inp); inp.click();
}
const slug = (s) => String(s || 'recorrido').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'recorrido';
function lengthKm(pts) { let m = 0; for (let i = 1; i < pts.length; i++) m += L.latLng(pts[i - 1][0], pts[i - 1][1]).distanceTo(L.latLng(pts[i][0], pts[i][1])); return m / 1000; }

// ======================= router =======================
async function render() {
  if (REC) return; // durante la grabación no cambiamos de pantalla
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const tab = parts[0] === 'ruta' ? 'rutas' : parts[0] === 'act' ? 'historial' : (parts[0] || 'hoy');
  document.querySelectorAll('nav.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  clearMaps();
  window.scrollTo(0, 0);
  try {
    if (!parts.length) await viewHoy();
    else if (parts[0] === 'rutas') await viewRutas();
    else if (parts[0] === 'ruta') await viewRuta(decodeURIComponent(parts[1]));
    else if (parts[0] === 'grabar') await viewGrabar(params);
    else if (parts[0] === 'historial') await viewHistorial(params);
    else if (parts[0] === 'act') await viewAct(decodeURIComponent(parts[1]));
    else if (parts[0] === 'mas') await viewMas();
    else await viewHoy();
  } catch (e) {
    console.error(e);
    app.replaceChildren(h('div', { class: 'card' }, h('b', {}, 'Algo falló'), h('div', { class: 'muted small' }, e.message)));
  }
}

async function boot() {
  S.home = await store.getSetting('home', null) || DEFAULT_HOME;
  S.profile = await store.getSetting('profile', 'trekking');
  S.voice = await store.getSetting('voice', true);
  S.keepScreen = await store.getSetting('keepScreen', true);

  // Migración desde el Training Log viejo (GitHub Pages) vía #legacy=<base64>
  if (location.hash.startsWith('#legacy=')) {
    try {
      const b64 = location.hash.slice(8).replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(escape(atob(b64)));
      const n = await store.importLegacy(JSON.parse(json));
      toast(`Importé ${n} sesiones del Training Log`);
    } catch (e) { toast('No pude importar los datos viejos'); }
    history.replaceState(null, '', '#/historial');
  }

  // si nunca se configuró la casa, ubicamos la dirección por defecto con precisión
  if (!(await store.getSetting('home', null))) {
    api(`/api/geocode?q=${encodeURIComponent('Avenida Chorroarín 530, Ciudad Autónoma de Buenos Aires')}`).then(async rs => {
      if (rs[0]) { S.home = { label: DEFAULT_HOME.label, lat: rs[0].lat, lon: rs[0].lon }; await store.setSetting('home', S.home); }
    }).catch(() => {});
  }

  window.addEventListener('hashchange', render);
  store.onSync(({ pulled }) => { if (pulled && !REC) render(); });
  render();
  store.scheduleSync(800);
  window.addEventListener('online', () => store.scheduleSync(500));

  if (!isNative && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  setupBackButton(({ canGoBack }) => {
    if (document.querySelector('.sheet-wrap')) { document.querySelector('.sheet-wrap .icon-btn')?.click(); return; }
    if (REC) { minimizeApp(); return; }           // grabando: nunca cerrar la app
    const hash = location.hash || '#/';
    if (hash !== '#/' && hash !== '') history.back(); else minimizeApp();
  });
  if (isNative) checkUpdate(true);
  try { await navigator.storage?.persist?.(); } catch {}
}

boot();
