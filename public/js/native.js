// Puente con la app Android (Capacitor). En el navegador todo esto queda inactivo.

const C = window.Capacitor;
export const isNative = Boolean(C?.isNativePlatform?.());
export const API_BASE = isNative ? 'https://pedal-ba-production.up.railway.app' : '';
export const apiUrl = (path) => API_BASE + path;
export const REPO = 'sebastianparnes/entrenamiento';
export const APK_URL = `https://github.com/${REPO}/releases/latest/download/pedal-ba.apk`;

const cache = {};
export function plugin(name) {
  if (!isNative) return null;
  return (cache[name] ||= C.registerPlugin(name));
}

export async function speak(text) {
  if (isNative) {
    try { await plugin('TextToSpeech').speak({ text, lang: 'es-AR', rate: 1.0, category: 'playback' }); return; } catch {}
  }
  if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(text); u.lang = 'es-AR'; speechSynthesis.speak(u); }
}

export async function ensureNotificationPermission() {
  if (!isNative) return;
  try {
    const LN = plugin('LocalNotifications');
    const st = await LN.checkPermissions();
    if (st.display !== 'granted') await LN.requestPermissions();
  } catch {}
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Guarda el archivo en el celular y abre el menú de compartir de Android
export async function nativeShare(blob, filename, title) {
  const FS = plugin('Filesystem');
  const data = await blobToBase64(blob);
  const res = await FS.writeFile({ path: filename, data, directory: 'CACHE' });
  try {
    await plugin('Share').share({ title, files: [res.uri], dialogTitle: title || 'Compartir' });
    return 'shared';
  } catch (e) {
    if (/cancel/i.test(e?.message || '')) return 'cancelled';
    throw e;
  }
}

export async function currentBuild() {
  try { return (await (await fetch('/build.json', { cache: 'no-store' })).json()).build || 0; } catch { return 0; }
}

export async function latestBuild() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('No pude consultar GitHub');
  const j = await r.json();
  const m = String(j.tag_name || '').match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

export function openExternal(url) {
  // en la app abre el navegador del sistema (para bajar la actualización)
  window.open(url, '_system') || (location.href = url);
}

export function setupBackButton(handler) {
  if (!isNative) return;
  plugin('App').addListener('backButton', handler);
}
export const minimizeApp = () => plugin('App')?.minimizeApp();
