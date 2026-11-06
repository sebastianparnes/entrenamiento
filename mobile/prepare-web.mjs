// Copia la PWA (../public) adentro de la app Android y anota el número de build.
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
const build = Number(process.env.BUILD_NUMBER || 0);
rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
cpSync('../public', 'www', { recursive: true });
rmSync('www/sw.js', { force: true });
writeFileSync('www/build.json', JSON.stringify({ build, builtAt: new Date().toISOString() }));
console.log(`www listo (build ${build})`);
