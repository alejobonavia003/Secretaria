// Nodo "Cerrar envío": último paso de cada vuelta del bucle "Recorrer mensajes". Recoge el resultado de ese mensaje (si el envío falló
// y si falló guardar el id de la confirmación) y lo devuelve al bucle; al terminar, el bucle entrega todos a "Comprobar envío".
// Devuelve SIEMPRE un item por cada uno de entrada.

const resumen = (e) =>
  String(typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e ?? '')))
    .replace(/\s+/g, ' ')
    .slice(0, 200);

return $input.all().map((item, i) => {
  const anotado = $('Anotar confirmación').itemMatching(i).json;
  // Solo si hubo que guardar el id: la respuesta de "Guardar id de la confirmación" puede ser un error
  const id_error = anotado.guardar && item.json?.error ? resumen(item.json.error) : null;
  // wamid y texto: lo que se mandó ; «Soltar turno» los junta para anotar la respuesta en el mensaje del usuario
  return { json: { envio_error: anotado.envio_error ?? null, id_error, wamid: anotado.wamid ?? null, texto: anotado.texto ?? '' }, pairedItem: { item: i } };
});
