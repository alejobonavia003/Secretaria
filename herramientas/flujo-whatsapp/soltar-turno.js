// Nodo "Soltar turno": tras mandar TODAS las respuestas (salida "done" del bucle "Recorrer mensajes"), dice qué turno de la cola hay que
// soltar: el del mensaje que esta ejecución procesó (lo dio "Juntar mensajes"). Solo entonces puede empezar el siguiente mensaje, así su
// respuesta nunca llega antes que esta. Devuelve los resultados de los envíos tal cual (los revisa "Comprobar envío") con el id añadido;
// sin turno (un archivo, un tipo no soportado) el id va vacío. Añade también «contestados»: los mensajes del usuario que contesta esta
// respuesta.

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
return $input.all().map((item, i) => ({ json: { ...item.json, soltar_turno: turno, contestados }, pairedItem: { item: i } }));
