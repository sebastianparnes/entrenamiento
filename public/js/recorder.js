// Grabación GPS. Funciona con la app abierta: el wake lock mantiene la
// pantalla prendida para que el navegador no corte el GPS.
import { distM, fmtPace, fmtNum } from './util.js';

const LIVE_KEY = 'pedal-live-v1';

export class Recorder {
  constructor({ type, routeId = null, onUpdate, voice = true }) {
    this.type = type; this.routeId = routeId; this.onUpdate = onUpdate; this.voice = voice;
    this.points = [];         // [lat, lon, tSec, ele]
    this.startedAt = null;
    this.pausedMs = 0; this.pauseStart = null;
    this.distM = 0; this.lastFix = null; this.accuracy = null; this.curKmh = 0;
    this.nextKm = 1; this.watchId = null; this.wakeLock = null; this.state = 'idle';
    this._vis = () => { if (document.visibilityState === 'visible' && this.state === 'running') this.lock(); };
  }

  static pending() {
    try { const s = JSON.parse(localStorage.getItem(LIVE_KEY) || 'null'); return s && s.points?.length ? s : null; } catch { return null; }
  }
  static clearPending() { localStorage.removeItem(LIVE_KEY); }

  restore(s) {
    Object.assign(this, { type: s.type, routeId: s.routeId, points: s.points, startedAt: s.startedAt, pausedMs: s.pausedMs || 0, distM: s.distM || 0, nextKm: s.nextKm || 1 });
    this.pauseStart = Date.now(); this.state = 'paused';
  }

  persist() {
    try {
      localStorage.setItem(LIVE_KEY, JSON.stringify({ type: this.type, routeId: this.routeId, points: this.points, startedAt: this.startedAt, pausedMs: this.pausedMs, distM: this.distM, nextKm: this.nextKm }));
    } catch {}
  }

  elapsedS() {
    if (!this.startedAt) return 0;
    const pausing = this.pauseStart ? Date.now() - this.pauseStart : 0;
    return Math.max(0, (Date.now() - this.startedAt - this.pausedMs - pausing) / 1000);
  }

  async start() {
    if (!('geolocation' in navigator)) throw new Error('Este navegador no tiene GPS disponible');
    if (!this.startedAt) this.startedAt = Date.now();
    if (this.pauseStart) { this.pausedMs += Date.now() - this.pauseStart; this.pauseStart = null; }
    this.lastFix = null; // tras una pausa no unimos con línea recta
    this.state = 'running';
    this.watchId = navigator.geolocation.watchPosition(p => this.onPos(p), e => this.onErr(e), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    document.addEventListener('visibilitychange', this._vis);
    await this.lock();
    this.tick = setInterval(() => this.emit(), 1000);
    this.emit();
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused'; this.pauseStart = Date.now();
    navigator.geolocation.clearWatch(this.watchId); this.watchId = null;
    this.persist(); this.emit();
  }

  async stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    clearInterval(this.tick);
    document.removeEventListener('visibilitychange', this._vis);
    try { await this.wakeLock?.release(); } catch {}
    if (this.pauseStart) { this.pausedMs += Date.now() - this.pauseStart; this.pauseStart = null; }
    this.state = 'stopped';
    Recorder.clearPending();
  }

  async lock() {
    try { if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }

  onErr(e) { this.error = e.code === 1 ? 'Sin permiso de ubicación. Habilitalo en el navegador.' : 'Buscando señal GPS…'; this.emit(); }

  onPos(pos) {
    this.error = null;
    const { latitude: lat, longitude: lon, accuracy, altitude, speed } = pos.coords;
    this.accuracy = accuracy;
    if (accuracy > 40) { this.emit(); return; }  // fix pobre: lo descartamos
    const t = Math.round(this.elapsedS());
    const p = [round(lat, 6), round(lon, 6), t, altitude != null ? round(altitude, 1) : null];
    if (this.lastFix) {
      const d = distM(this.lastFix, p);
      const dt = Math.max(1, (pos.timestamp - this.lastFix.ts) / 1000);
      const kmh = (d / dt) * 3.6;
      const maxKmh = this.type === 'bici' ? 85 : 35;
      if (kmh > maxKmh) { this.emit(); return; }               // salto imposible
      if (d < Math.max(3, accuracy * 0.4)) {                    // quieto: no sumamos ruido
        this.curKmh = speed != null && speed >= 0 ? speed * 3.6 : 0;
        this.emit(); return;
      }
      this.distM += d;
      this.curKmh = speed != null && speed >= 0 ? speed * 3.6 : kmh;
    }
    p.ts = pos.timestamp;
    this.lastFix = p;
    this.points.push([p[0], p[1], p[2], p[3]]);
    if (this.points.length % 5 === 0) this.persist();
    this.announce();
    this.emit();
  }

  announce() {
    const km = this.distM / 1000;
    if (km < this.nextKm) return;
    const el = this.elapsedS();
    const msg = this.type === 'bici'
      ? `Kilómetro ${this.nextKm}. Promedio ${fmtNum(km / (el / 3600), 1)} kilómetros por hora.`
      : `Kilómetro ${this.nextKm}. Ritmo ${fmtPace(km, el).replace(':', ' minutos ')} segundos por kilómetro.`;
    this.nextKm = Math.floor(km) + 1;
    if (this.voice && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(msg); u.lang = 'es-AR'; speechSynthesis.speak(u);
    }
    if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
  }

  emit() { this.onUpdate?.(this); }
}

function round(x, d) { const k = 10 ** d; return Math.round(x * k) / k; }
