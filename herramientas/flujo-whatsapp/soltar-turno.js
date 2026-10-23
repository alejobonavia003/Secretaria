// Nodo "Soltar turno": tras mandar TODAS las respuestas (salida "done" del bucle "Recorrer mensajes"), dice qué turno de la cola hay que
// soltar: el del mensaje que esta ejecución procesó (lo dio "Juntar mensajes"). Solo entonces puede empezar el siguiente mensaje, así su
// respuesta nunca llega antes que esta. Devuelve los resultados de los envíos tal cual (los revisa "Comprobar envío") con el id añadido;
// sin turno (un archivo, un tipo no soportado) el id va vacío. Añade también «contestados»: los mensajes del usuario que contesta esta
// respuesta, y «respuesta_wamids» / «respuesta_texto»: lo que se mandó, para poder citarlo luego.

let turno = '';
try {
  const procesado = $('Juntar mensajes').all().map((x) => x.json).find((j) => j && j.accion === 'procesar' && typeof j.mensaje_id === 'string');
  if (procesado) turno = procesado.mensaje_id;
} catch (e) {
  turno = ''; // "Juntar mensajes" no corrió en esta ejecución
}
// Los mensajes que esta respuesta contesta (los apunta «Preparar envío» en el primero de cada respuesta): «Marcar contestados» los anota
let contestados = [];
try {
  contestados = [...new Set($('Turno de respuesta').all().flatMap((x) => (Array.isArray(x.json?.contesta) ? x.json.contesta : [])))];
} catch (e) {
  contestados = [];
}
// Lo que se ha mandado (ids de WhatsApp y texto, en orden): «Guardar respuesta» lo anota en los mensajes del usuario que contesta (base de datos 1.4).
// Así, al citar cualquiera de estos mensajes, la secretaria sabe a qué te refieres. Texto recortado a 1.500 caracteres.
const enviados = $input.all().map((x) => x.json).filter((j) => j && typeof j.wamid === 'string' && j.wamid !== '');
const respuestaWamids = [...new Set(enviados.map((j) => j.wamid))];
const respuestaTexto = enviados.map((j) => String(j.texto ?? '').trim()).filter(Boolean).join('\n\n').slice(0, 1500);
return $input.all().map((item, i) => ({ json: { ...item.json, soltar_turno: turno, contestados, respuesta_wamids: respuestaWamids, respuesta_texto: respuestaTexto }, pairedItem: { item: i } }));
