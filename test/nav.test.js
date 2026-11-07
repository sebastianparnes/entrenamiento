import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManeuvers, instruction, spokenDistance, cumulative } from '../public/js/maneuvers.js';
import { Navigator } from '../public/js/nav.js';

// Ruta en "L": 1 km al norte, giro a la derecha (este) 600 m, giro a la izquierda (norte) 400 m
const M = 1 / 111000;
const pts = [];
for (let i = 0; i <= 50; i++) pts.push([-34.6 + i * 20 * M, -58.45]);
const lonK = 1 / (111320 * Math.cos(-34.59 * Math.PI / 180));
const top = pts[pts.length - 1];
for (let i = 1; i <= 30; i++) pts.push([top[0], -58.45 + i * 20 * lonK]);
const corner = pts[pts.length - 1];
for (let i = 1; i <= 20; i++) pts.push([corner[0] + i * 20 * M, corner[1]]);

test('detecta giros con su lado', () => {
  const ms = buildManeuvers(pts, null);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].type, 'turn'); assert.ok(ms[0].angle > 0, 'primer giro a la derecha');
  assert.equal(ms[1].type, 'turn'); assert.ok(ms[1].angle < 0, 'segundo giro a la izquierda');
  assert.equal(instruction(ms[0]), 'Doblá a la derecha');
  assert.equal(instruction(ms[1]), 'Doblá a la izquierda');
  assert.ok(Math.abs(ms[0].d - 1000) < 25);
});

test('usa las posiciones de BRouter cuando vienen', () => {
  const ms = buildManeuvers(pts, [[50, 5, 0, 600, 90], [80, 2, 0, 400, -90], [10, 1, 0, 0, 0]]);
  assert.deepEqual(ms.map(m => m.type), ['turn', 'turn']);
  const r = buildManeuvers(pts, [[50, 13, 2, 600, 90]]);
  assert.equal(r[0].type, 'roundabout');
  assert.equal(instruction(r[0]), 'En la rotonda, tomá la segunda salida');
});

test('distancias habladas', () => {
  assert.equal(spokenDistance(263), '250 metros');
  assert.equal(spokenDistance(84), '80 metros');
  assert.equal(spokenDistance(1260), '1,3 kilómetros');
});

test('navegación: anuncia giros, fuera de ruta y llegada', () => {
  const said = [];
  const nav = new Navigator({ coords: pts }, { mode: 'bici', say: (t) => said.push(t) });
  const cum = cumulative(pts);
  const at = (d) => { // punto sobre la ruta a d metros
    let i = 1; while (i < pts.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  for (let d = 0; d <= 1300; d += 6) { const p = at(d); nav.update(p[0], p[1], 25); }
  // se sale 120 m al sur-este durante varias lecturas
  for (let k = 0; k < 5; k++) { const p = at(1300); nav.update(p[0] - 120 * M, p[1], 20); }
  const p = at(1310); nav.update(p[0], p[1], 20);
  for (let d = 1310; d <= cum[cum.length - 1]; d += 6) { const q = at(d); nav.update(q[0], q[1], 25); }
  const txt = said.join(' | ');
  assert.match(said[0], /^Navegación iniciada/);
  assert.ok(said.some(s => /^En (2|3)\d0 metros, doblá a la derecha/.test(s)), txt);
  assert.ok(said.some(s => /^En \d+ metros, doblá a la derecha/.test(s)), txt);
  assert.ok(said.some(s => s.startsWith('Doblá a la derecha')), txt);
  assert.ok(said.some(s => /Te saliste de la ruta/.test(s)), txt);
  assert.ok(said.some(s => /Volviste a la ruta/.test(s)), txt);
  assert.ok(said.some(s => s.startsWith('Doblá a la izquierda')), txt);
  assert.ok(said.some(s => /Llegaste/.test(s)), txt);
  // ningún giro se anuncia "ahora" dos veces
  assert.equal(said.filter(s => s.startsWith('Doblá a la derecha')).length, 1, txt);
  console.log(said.join('\n'));
});
