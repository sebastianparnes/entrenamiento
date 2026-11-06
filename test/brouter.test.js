import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBrouter, classifyTags } from '../lib/brouter.js';

test('clasifica tipos de vía', () => {
  assert.equal(classifyTags('highway=cycleway surface=asphalt'), 'bike');
  assert.equal(classifyTags('highway=primary cycleway:right=track'), 'bike');
  assert.equal(classifyTags('highway=residential'), 'calm');
  assert.equal(classifyTags('highway=secondary lanes=3'), 'road');
});

test('analiza la respuesta de BRouter', () => {
  const coords = [[-58.48, -34.59, 25], [-58.47, -34.585, 26], [-58.46, -34.58, 27], [-58.45, -34.575, 25]];
  const gj = { features: [{ geometry: { coordinates: coords }, properties: {
    'track-length': '3000', 'filtered ascend': '4',
    messages: [
      ['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags', 'NodeTags', 'Time', 'Energy'],
      ['-58470000', '-34585000', '26', '1000', '1000', '0', '0', '0', '0', 'highway=cycleway', '', '0', '0'],
      ['-58460000', '-34580000', '27', '1000', '1000', '0', '0', '0', '0', 'highway=residential', '', '0', '0'],
      ['-58450000', '-34575000', '25', '1000', '1000', '0', '0', '0', '0', 'highway=primary surface=gravel', '', '0', '0'],
    ] } }] };
  const r = analyzeBrouter(gj);
  assert.equal(r.distanceKm, 3);
  assert.equal(r.ascentM, 4);
  assert.equal(r.coords[0][0], -34.59);
  assert.ok(Math.abs(r.share.bike - 1 / 3) < 0.01);
  assert.ok(Math.abs(r.share.unpaved - 1 / 3) < 0.01);
  assert.deepEqual(r.spans.map(s => s.cls), ['bike', 'calm', 'road']);
  assert.equal(r.spans.at(-1).to, 3);
});
