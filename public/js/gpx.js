// Exportar / importar GPX (para relojes, Strava, Garmin, Wikiloc, Komoot...)
import { esc } from './util.js';

export function toGPX({ name, type, points, startedAt }) {
  // points: [lat, lon, tSec?, ele?]
  const hasTime = startedAt && points.some(p => p[2] != null);
  const trkpts = points.map(p => {
    const ele = p[3] != null ? `<ele>${p[3]}</ele>` : '';
    const time = hasTime && p[2] != null ? `<time>${new Date(startedAt + p[2] * 1000).toISOString()}</time>` : '';
    return `<trkpt lat="${p[0]}" lon="${p[1]}">${ele}${time}</trkpt>`;
  }).join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Pedal BA" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name>${startedAt ? `<time>${new Date(startedAt).toISOString()}</time>` : ''}</metadata>
  <trk>
    <name>${esc(name)}</name>${type ? `\n    <type>${esc(type)}</type>` : ''}
    <trkseg>
      ${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('El archivo no es un GPX válido');
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
  if (!nodes.length) nodes = [...doc.getElementsByTagName('wpt')];
  if (nodes.length < 2) throw new Error('El GPX no tiene puntos de recorrido');
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim() || '';
  const typeTxt = (doc.querySelector('trk > type')?.textContent || '').toLowerCase();
  let t0 = null;
  const points = nodes.map(n => {
    const lat = Number(n.getAttribute('lat')), lon = Number(n.getAttribute('lon'));
    const eleTxt = n.getElementsByTagName('ele')[0]?.textContent;
    const timeTxt = n.getElementsByTagName('time')[0]?.textContent;
    let t = null;
    if (timeTxt) { const ms = Date.parse(timeTxt); if (Number.isFinite(ms)) { if (t0 == null) t0 = ms; t = Math.round((ms - t0) / 1000); } }
    return [round(lat, 6), round(lon, 6), t, eleTxt != null ? round(Number(eleTxt), 1) : null];
  }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const type = /run|corr|running/.test(typeTxt) ? 'correr' : /walk|camin|hik/.test(typeTxt) ? 'caminar' : /bik|cycl|ride|bici/.test(typeTxt) ? 'bici' : null;
  return { name, type, points, startedAt: t0 };
}

function round(x, d) { const k = 10 ** d; return Math.round(x * k) / k; }
