// Nodo "Preparar": deja un item por cada cosa pendiente de hacer en Drive, primero los archivos y después las carpetas pedidas.
// Los archivos primero porque "Leer padres" devuelve una respuesta por item, en el mismo orden, y solo los archivos la usan.
// "Leer pendientes" y "Leer carpetas pendientes" devuelven siempre algo (Always Output Data), aunque sea un item vacío:
// aquí se descarta. Si no queda ninguno, devuelve [] y el flujo termina sin tocar Drive.

const filas = (items) => items.map((i) => i.json).filter((r) => r && typeof r === 'object');

const archivos = filas($('Leer pendientes').all()).filter((r) => typeof r.id === 'string' && typeof r.drive_file_id === 'string' && r.drive_file_id !== '');
const carpetas = filas($input.all()).filter((r) => typeof r.id === 'string' && typeof r.ruta === 'string' && r.ruta !== '');

return [...archivos.map((archivo) => ({ json: { archivo } })), ...carpetas.map((carpeta) => ({ json: { carpeta } }))];
