# Pedal BA

App personal (PWA instalable) para:

- **Rutas en bici de 25–35 km saliendo de casa** por CABA y zona norte, priorizando ciclovías y bicisendas y lugares donde se puede tirar velocidad (Bosques de Palermo, Costanera Norte, Paseo de la Costa de Vicente López, San Isidro, Parque Sarmiento, Puerto Madero). Cada ruta muestra qué porcentaje va por ciclovía, por calles tranquilas y por avenidas.
- **Recomendación del día** según clima, viento (salir contra el viento y volver a favor), lluvia, hora y día de la semana.
- **Loops a medida**: elegís distancia y dirección y la app arma la vuelta.
- **Grabar entrenamientos con GPS** (bici, correr, caminar) con avisos por voz cada km, y **carga manual** para cinta.
- **Historial** con totales por semana/mes/año y gráfico semanal.
- **Compartir** el recorrido como imagen, GIF animado o video (estilo Relive).
- GPX: exportar rutas/actividades e importar de Strava, Wikiloc, Komoot o un reloj.

## Cómo funciona

- `server.js`: servidor Node sin dependencias. Sirve la app y hace de proxy a
  - [BRouter](https://brouter.de) — ruteo en bici sobre OpenStreetMap,
  - [Open-Meteo](https://open-meteo.com) — clima,
  - [Nominatim](https://nominatim.org) — búsqueda de direcciones.
- `public/`: la PWA (Leaflet + módulos ES, sin build). Los datos se guardan en IndexedDB del celular.
- Sincronización opcional: si el servidor tiene `APP_TOKEN` y un volumen en `DATA_DIR`, las actividades se respaldan ahí (se ingresa la clave en **Más → Sincronización**).

## Variables de entorno

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (Railway lo define solo) |
| `APP_TOKEN` | Clave para sincronizar actividades |
| `DATA_DIR` | Carpeta persistente (volumen de Railway en `/data`) |

## Correr localmente

```bash
npm start        # http://localhost:3000
npm test
```

## Limitaciones

- El GPS graba con la app abierta y la pantalla prendida (la app la mantiene encendida). Los navegadores no permiten usar la ubicación en segundo plano.

## App vieja

La versión anterior (Training Log) quedó en `legacy/` y en la rama `legacy-2026`. Si abrís la dirección vieja de GitHub Pages, te ofrece pasar las sesiones guardadas a Pedal BA.
