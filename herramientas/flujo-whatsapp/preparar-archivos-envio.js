// Nodo "Preparar archivos a enviar": de la respuesta que se acaba de mandar saca la SECUENCIA de archivos que hay que mandar por WhatsApp, en
// orden: antes del primer archivo de cada carpeta va un item "cabecera" (con el nombre de la carpeta y el número de archivos) y
// después uno "archivo" por cada archivo. El flujo principal ya entrega los archivos agrupados por carpeta. Si no hay ninguno
// (casi siempre) devuelve [] y la rama termina sin hacer nada. Va DESPUÉS de mandar el texto y ANTES de soltar el turno: los
// archivos los trae «Preparar envío» (campo envios_archivos del flujo principal) en el primer mensaje, y se leen de «Turno de respuesta».
// Se revalida todo: lista, id de Drive válido y un tope de archivos, por si el flujo principal devolviera algo raro.
// Después "Recorrer envíos" procesa un item cada vez (cabecera o archivo), de principio a fin, y solo entonces pasa al siguiente.

/*__COMUN__*/

const validos = [];
for (const item of $('Turno de respuesta').all()) {
  const lista = Array.isArray(item.json?.envios_archivos) ? item.json.envios_archivos : [];
  for (const a of lista.slice(0, MAX_ENVIOS_ARCHIVOS)) {
    if (!a || typeof a.drive_file_id !== 'string' || !ID_DRIVE_ENVIO.test(a.drive_file_id)) continue;
    validos.push({
      drive_file_id: a.drive_file_id,
      nombre: typeof a.nombre === 'string' ? a.nombre : '',
      tipo_mime: typeof a.tipo_mime === 'string' ? a.tipo_mime : '',
      ruta: typeof a.ruta === 'string' ? a.ruta : '',
    });
  }
}

const cabeceras = cabecerasDeEnvio(validos.map((v) => v.ruta));
const salida = [];
validos.forEach((v, n) => {
  if (cabeceras[n]) salida.push({ json: { tipo: 'cabecera', ruta: cabeceras[n].ruta, total: cabeceras[n].total } });
  salida.push({ json: { tipo: 'archivo', ...v } });
});
return salida;
