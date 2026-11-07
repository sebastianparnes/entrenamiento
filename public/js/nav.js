// Navegación giro a giro por voz, estilo Google Maps.
import { cumulative, buildManeuvers, instruction, spokenDistance, lowerFirst, bearing, compassName } from './maneuvers.js';

const ON_ROUTE_M = 35;     // a menos de esto estás en la ruta
const OFF_ROUTE_M = 50;    // a más de esto (varias lecturas seguidas) te saliste
const OFF_REPEAT_MS = 45000;

export class Navigator {
  constructor(data, { mode = 'bici', say, destName = '', onArrive = null }) {
    this.destName = destName; this.onArrive = onArrive; this.arrived = false;
    this.pts = data.coords.map(c => [c[0], c[1]]);
    this.cum = cumulative(this.pts);
    this.total = this.cum[this.cum.length - 1] || 0;
    const mans = data.maneuvers?.length ? data.maneuvers : buildManeuvers(this.pts, null);
    this.man = mans.map(m => ({ ...m, a: this.cum[m.i] ?? m.d }));
    this.man.push({ type: 'arrive', a: this.total, i: this.pts.length - 1, angle: 0 });
    this.mode = mode; this.say = say;
    this.along = null; this.off = false; this.offCount = 0; this.lastOffSay = 0;
    this.stage = new Map(); this.continueAfter = null; this.started = false; this.done = false;
    this.state = null;
  }

  thresholds(kmh) {
    const v = Math.max(this.mode === 'bici' ? 4 : 1.2, (kmh || 0) / 3.6); // m/s
    if (this.mode === 'bici') return { far: Math.min(400, Math.max(180, v * 30)), near: Math.max(50, v * 10), now: Math.max(18, v * 3.5) };
    return { far: 150, near: 50, now: 12 };
  }

  // Punto más cercano de la ruta entre dos distancias recorridas
  locate(p, fromA = -Infinity, toA = Infinity, { earliestWithin = null } = {}) {
    const k = Math.cos((p[0] * Math.PI) / 180) * 111320, kl = 110540;
    let best = null;
    for (let j = 0; j < this.pts.length - 1; j++) {
      if (this.cum[j + 1] < fromA) continue;
      if (this.cum[j] > toA) break;
      const ax = (this.pts[j][1] - p[1]) * k, ay = (this.pts[j][0] - p[0]) * kl;
      const bx = (this.pts[j + 1][1] - p[1]) * k, by = (this.pts[j + 1][0] - p[0]) * kl;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const ex = ax + t * dx, ey = ay + t * dy;
      const dist = Math.hypot(ex, ey);
      const along = this.cum[j] + t * (this.cum[j + 1] - this.cum[j]);
      if (earliestWithin != null && dist <= earliestWithin) return { dist, along, j };
      if (!best || dist < best.dist) best = { dist, along, j, pt: [this.pts[j][0] + (this.pts[j + 1][0] - this.pts[j][0]) * t, this.pts[j][1] + (this.pts[j + 1][1] - this.pts[j][1]) * t] };
    }
    return best;
  }

  update(lat, lon, kmh) {
    if (this.done) return this.state;
    const p = [lat, lon];
    let hit;
    if (this.along == null) {
      // al arrancar: el primer tramo de la ruta que pase cerca (las vueltas repiten tramos)
      hit = this.locate(p, -Infinity, Infinity, { earliestWithin: ON_ROUTE_M }) || this.locate(p);
    } else {
      hit = this.locate(p, this.along - 80, this.along + 700);
      if (!hit || hit.dist > ON_ROUTE_M) {
        const ahead = this.locate(p, this.along - 80, Infinity, { earliestWithin: 30 });
        if (ahead) hit = ahead;
      }
    }
    const now = Date.now();
    if (hit && hit.dist <= ON_ROUTE_M) {
      if (this.off) { this.off = false; this.say('Volviste a la ruta.'); this.resetUpcoming(hit.along); }
      this.offCount = 0;
      this.along = hit.along;
    } else {
      this.offCount++;
      const far = this.locate(p, (this.along ?? 0) - 80);
      const d = far?.dist ?? Infinity;
      if (this.offCount >= 3 && d > OFF_ROUTE_M) {
        const dir = far?.pt ? compassName(bearing(p, far.pt)) : '';
        const msg = `${spokenDistance(d)} hacia el ${dir}`;
        if (!this.off) { this.off = true; this.lastOffSay = now; this.say(this.along == null ? `El inicio de la ruta está a ${msg}.` : `Te saliste de la ruta. Está a ${msg}.`); }
        else if (now - this.lastOffSay > OFF_REPEAT_MS) { this.lastOffSay = now; this.say(`Seguís fuera de la ruta. Está a ${msg}.`); }
      }
      this.state = { off: this.off, offDist: d, along: this.along ?? 0, total: this.total, next: this.state?.next, dist: this.state?.dist };
      return this.state;
    }

    const T = this.thresholds(kmh);
    const ni = this.man.findIndex(m => m.a > this.along + 3);
    const m = this.man[ni];
    if (!m) { this.done = true; return this.state; }
    const dist = m.a - this.along;
    const st = this.stage.get(ni) || 0;
    const text = instruction(m);

    if (!this.started) {
      this.started = true;
      const intro = this.destName ? `Vamos a ${this.destName}: ${spokenDistance(this.total - this.along)}.` : `Navegación iniciada. Ruta de ${spokenDistance(this.total - this.along)}.`;
      if (m.type === 'arrive') this.say(intro);
      else if (dist <= T.near) { this.say(`${intro} ${text}.`); this.stage.set(ni, 3); }
      else if (dist <= T.far) { this.say(`${intro} En ${spokenDistance(dist)}, ${lowerFirst(text)}.`); this.stage.set(ni, 1); }
      else { this.say(`${intro} Seguí derecho ${spokenDistance(dist)}.`); this.stage.set(ni, 0.5); }
    } else if (m.type === 'arrive') {
      if (dist <= 25 && st < 3) {
        this.say(this.destName ? `Llegaste a ${this.destName}.` : 'Llegaste. Terminaste la ruta. ¡Bien ahí!');
        this.stage.set(ni, 3); this.done = true; this.arrived = true; this.onArrive?.();
      }
      else if (dist <= T.near * 2 && st < 2) { this.say(`En ${spokenDistance(dist)} llegás ${this.destName ? 'a ' + this.destName : 'al final de la ruta'}.`); this.stage.set(ni, 2); }
    } else if (dist <= T.now && st < 3) {
      this.say(`${text}${this.chained(ni)}.`);
      this.stage.set(ni, 3); this.continueAfter = ni;
    } else if (dist <= T.near && st < 2) {
      this.say(`En ${spokenDistance(dist)}, ${lowerFirst(text)}${this.chained(ni)}.`);
      this.stage.set(ni, 2);
    } else if (dist <= T.far && dist > T.near + 30 && st < 1) {
      this.say(`En ${spokenDistance(dist)}, ${lowerFirst(text)}.`);
      this.stage.set(ni, 1);
    }

    // después de un giro, si el próximo está lejos: "seguí derecho X"
    if (this.continueAfter != null && ni > this.continueAfter) {
      const prev = this.man[this.continueAfter];
      if (this.along > prev.a + 20) {
        if (dist > T.far + 150 && m.type !== 'arrive') { this.say(`Seguí derecho ${spokenDistance(dist)}.`); this.stage.set(ni, Math.max(this.stage.get(ni) || 0, 0.5)); }
        this.continueAfter = null;
      }
    }

    this.state = { off: false, next: m, text, dist, along: this.along, total: this.total };
    return this.state;
  }

  chained(ni) {
    const m = this.man[ni], n2 = this.man[ni + 1];
    if (!n2 || n2.type === 'arrive' || n2.a - m.a > 60) return '';
    this.stage.set(ni + 1, Math.max(this.stage.get(ni + 1) || 0, 2));
    return ` y enseguida, ${lowerFirst(instruction(n2))}`;
  }

  resetUpcoming(along) {
    for (const [k] of this.stage) if (this.man[k] && this.man[k].a > along + 3) this.stage.delete(k);
  }
}

// Flecha para el cartel de navegación
export function arrowSvg(m) {
  if (!m) return '';
  if (m.type === 'arrive') return '<svg viewBox="0 0 48 48"><path d="M24 4c-7 0-12 5-12 12 0 9 12 26 12 26s12-17 12-26c0-7-5-12-12-12zm0 17a5 5 0 110-10 5 5 0 010 10z" fill="currentColor"/></svg>';
  if (m.type === 'uturn') return `<svg viewBox="0 0 48 48"><path d="M${m.angle < 0 ? '30 42V18a8 8 0 00-16 0v6' : '18 42V18a8 8 0 0116 0v6'}" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M${m.angle < 0 ? '7 22l7 8 7-8' : '27 22l7 8 7-8'}" fill="currentColor"/></svg>`;
  if (m.type === 'roundabout') return `<svg viewBox="0 0 48 48"><circle cx="24" cy="26" r="9" stroke="currentColor" stroke-width="4" fill="none"/><path d="M24 44V35" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><text x="24" y="31" text-anchor="middle" font-size="13" font-weight="900" fill="currentColor">${m.exit}</text><path d="M24 17V5m-6 6l6-7 6 7" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const a = Math.max(-150, Math.min(150, m.angle || 0));
  return `<svg viewBox="0 0 48 48"><path d="M24 44V26" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><g transform="rotate(${a} 24 26)"><path d="M24 26V8" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M15 14l9-10 9 10z" fill="currentColor"/></g></svg>`;
}
