// Convierte la respuesta GeoJSON de BRouter en algo útil para la app:
// coordenadas, distancia, desnivel y qué parte del recorrido va por
// ciclovía/bicisenda, por calles tranquilas o por avenidas.

const BIKE_RE = /(^|\s)(highway=cycleway|cycleway(:right|:left|:both)?=(track|lane|opposite_track|opposite_lane|separate|shared_busway)|bicycle=designated|route_bicycle_icn|route_bicycle_ncn|route_bicycle_rcn|route_bicycle_lcn)(\s|$)/;
const CALM_RE = /(^|\s)highway=(residential|living_street|service|pedestrian|track|path|footway|bridleway)(\s|$)/;
const UNPAVED_RE = /(^|\s)surface=(unpaved|gravel|fine_gravel|dirt|ground|grass|sand|earth|mud|compacted|pebblestone)(\s|$)/;

export function classifyTags(tags = '') {
  if (BIKE_RE.test(tags)) return 'bike';
  if (CALM_RE.test(tags)) return 'calm';
  return 'road';
}

function haversine(a, b) {
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function analyzeBrouter(gj) {
  const f = gj?.features?.[0];
  if (!f) throw Object.assign(new Error('El ruteador no devolvió un recorrido'), { status: 502 });
  const props = f.properties || {};
  // [lon, lat, ele] -> [lat, lon, ele]
  const coords = (f.geometry?.coordinates || []).map(c => [round(c[1], 6), round(c[0], 6), c[2] != null ? round(c[2], 1) : null]);

  const msgs = Array.isArray(props.messages) ? props.messages : [];
  const header = msgs[0] || [];
  const iLon = header.indexOf('Longitude'), iLat = header.indexOf('Latitude');
  const iDist = header.indexOf('Distance'), iTags = header.indexOf('WayTags');

  const totals = { bike: 0, calm: 0, road: 0 };
  let unpaved = 0;
  const spans = []; // {from, to, cls} sobre índices de coords
  let idx = 0;
  for (let m = 1; m < msgs.length; m++) {
    const row = msgs[m];
    const dist = Number(row[iDist]) || 0;
    const tags = String(row[iTags] || '');
    const cls = classifyTags(tags);
    totals[cls] += dist;
    if (UNPAVED_RE.test(tags)) unpaved += dist;
    // el mensaje describe el tramo que termina en (lon,lat); buscamos ese punto
    const end = [Number(row[iLat]) / 1e6, Number(row[iLon]) / 1e6];
    let best = idx, bestD = Infinity;
    for (let k = idx; k < Math.min(coords.length, idx + 4000); k++) {
      const d = Math.abs(coords[k][0] - end[0]) + Math.abs(coords[k][1] - end[1]);
      if (d < bestD) { bestD = d; best = k; if (d < 2e-6) break; }
    }
    if (best > idx || spans.length === 0) {
      const last = spans[spans.length - 1];
      if (last && last.cls === cls && last.to === idx) last.to = best;
      else spans.push({ from: idx, to: best, cls });
      idx = best;
    }
  }
  if (spans.length && spans[spans.length - 1].to < coords.length - 1) spans[spans.length - 1].to = coords.length - 1;

  let lengthM = Number(props['track-length']);
  if (!Number.isFinite(lengthM) || lengthM <= 0) {
    lengthM = 0;
    for (let i = 1; i < coords.length; i++) lengthM += haversine(coords[i - 1], coords[i]);
  }
  const classified = totals.bike + totals.calm + totals.road || lengthM || 1;
  return {
    coords,
    spans: spans.length ? spans : [{ from: 0, to: Math.max(0, coords.length - 1), cls: 'road' }],
    distanceKm: round(lengthM / 1000, 2),
    ascentM: Math.round(Number(props['filtered ascend']) || 0),
    share: {
      bike: round(totals.bike / classified, 3),
      calm: round(totals.calm / classified, 3),
      road: round(totals.road / classified, 3),
      unpaved: round(unpaved / classified, 3),
    },
  };
}

function round(x, d) { const k = 10 ** d; return Math.round(x * k) / k; }
