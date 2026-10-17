// Nodo "Soltar turno": tras mandar TODAS las respuestas (salida "done" del bucle "Recorrer mensajes"), dice qué turno de la cola hay que
// soltar: el del mensaje que esta ejecución procesó (lo dio "Juntar mensajes"). Solo entonces puede empezar el siguiente mensaje, así su
// respuesta nunca llega antes que esta. Devuelve los resultados de los envíos tal cual (los revisa "Comprobar envío") con el id añadido;
// sin turno (un archivo, un tipo no soportado) el id va vacío.

let turno = '';
try {
  const procesado = $('Juntar mensajes').all().map((x) => x.json).find((j) => j && j.accion === 'procesar' && typeof j.mensaje_id === 'string');
  if (procesado) turno = procesado.mensaje_id;
} catch (e) {
  turno = ''; // "Juntar mensajes" no corrió en esta ejecución
}
return $input.all().map((item, i) => ({ json: { ...item.json, soltar_turno: turno }, pairedItem: { item: i } }));
