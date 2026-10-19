// Nodo "Turno de respuesta": decide, con lo que dijo «¿Me toca contestar?» (turno_respuesta), si los mensajes de
// «Preparar envío» salen ya o esperan:
//   - esperar  queda algo que llegó ANTES sin contestar (una foto de la que se contesta después un texto, un texto que aún se procesa):
//              devuelve { esperar: true } y el flujo vuelve a preguntar tras «Esperar para contestar». Las respuestas de la cola de texto
//              nunca esperan aquí (ya salieron de la cola en orden; esperar podría bloquear al que espera su turno). Si lleva esperando más
//              de lo que tarda en caducar un turno (TURNO_MIN, contado desde «Preparar envío»), contesta igualmente (mejor tarde que nunca).
//   - enviar   devuelve los mensajes, sin los campos internos, con la cita SOLO si el usuario ha mandado varios: la respuesta
//              es de varios mensajes juntos o de uno que llegó mientras se contestaba otro, quedan mensajes suyos posteriores sin contestar,
//              o esta ejecución contesta a varios a la vez (varias fotos de golpe).
// Si la lectura falló (base de datos sin actualizar, Supabase caído…), se contesta sin esperar y sin más cita que la de esas reglas.

const config = $('Configuración').first().json.config;
const envios = $('Preparar envío').all();
const turno = $input.first()?.json ?? {};

const deCola = envios.some((e) => e.json.de_cola === true);
const desde = Math.min(...envios.map((e) => e.json.desde).filter((d) => Number.isFinite(d)), Date.now());
const esperado = Date.now() - desde;
if (turno.accion === 'esperar' && !deCola && esperado < config.turno_min * 60000) {
  return [{ json: { esperar: true, esperado_s: Math.round(esperado / 1000) } }];
}

const despues = turno.despues === true;
const varias = new Set(envios.map((e) => e.json.responde_a).filter(Boolean)).size > 1;
return envios.map((e) => {
  const { responde_a, varios_mensajes, de_cola, desde: _desde, ...resto } = e.json;
  const citar = Boolean(responde_a) && (varios_mensajes === true || despues || varias);
  return { json: citar ? { ...resto, responde_a } : resto, pairedItem: { item: 0 } }; // todos salen del único item de «¿Me toca contestar?»
});
