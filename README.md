# Training Log

PWA personal de registro de entrenamiento cardio (correr, cinta, bici, caminata).

## Características

- Stats diarias / semanales / mensuales / anuales / acumuladas
- Gráfico de los últimos 14 días
- Velocidad promedio y pace por sesión
- Datos guardados en `localStorage` del navegador
- Exportar / importar JSON para backup
- Funciona offline (service worker)
- Instalable como app en el celular

## Uso

Abrir `index.html` en el navegador, o publicar en GitHub Pages y abrir la URL desde el celular.

Desde el celular: "Agregar a pantalla de inicio" (Android Chrome) o "Compartir → Agregar a pantalla de inicio" (iOS Safari).

## Backup

Los datos viven en el `localStorage` del navegador. Si limpiás caché o cambiás de celular, se pierden. Usar el botón **Exportar** cada tanto para bajar un JSON de respaldo.
