// Nodo "Comprobar envío": hace VISIBLE un fallo que el flujo deja pasar a propósito.
//
// "Enviar WhatsApp" y "Procesar mensaje" tienen onError = continueRegularOutput para que, pase lo que pase, el usuario reciba una
// respuesta honesta. Efecto secundario: un 4xx de Meta (token caducado, plantilla, número) o un fallo del flujo principal dejaban
// la ejecución en VERDE y nadie se enteraba. Este nodo corre DESPUÉS de que se hayan enviado todos los mensajes (cuelga de la
// salida "done" del bucle "Recorrer mensajes"), y si encuentra algo malo lanza un error: la ejecución queda en rojo y el flujo "Aviso de fallos" puede avisarte.
// Si todo fue bien no devuelve nada.

const resumen = (e) =>
  String(typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e ?? '')))
    .replace(/\s+/g, ' ')
    .slice(0, 200);
// Un nodo que no se ha ejecutado en esta ejecución (por ejemplo la rama de archivos no pasa por "Procesar mensaje") lanza al pedirlo
const filas = (nombre) => {
  try {
    return $(nombre).all().map((i) => i.json);
  } catch (e) {
    return [];
  }
};

const problemas = [];

// Los envíos de texto salen de uno en uno por el bucle "Recorrer mensajes", que entrega el resultado de cada uno ("done") a "Soltar turno",
// y este los pasa tal cual (con el turno que hay que soltar); entre medias puede ir "Liberar turno", así que se leen por su nombre
const envios = filas('Soltar turno');
const fallidos = envios.filter((r) => r && r.envio_error);
if (fallidos.length > 0) problemas.push(`${fallidos.length} de ${envios.length} mensajes no se enviaron (${resumen(fallidos[0].envio_error)})`);

const ecos = filas('Enviar lo entendido');
const ecosFallidos = ecos.filter((r) => r && r.error);
if (ecosFallidos.length > 0) problemas.push(`${ecosFallidos.length} de ${ecos.length} mensajes de «lo que he entendido» no se enviaron (${resumen(ecosFallidos[0].error)})`);

const procesados = filas('Procesar mensaje');
const malos = procesados.filter((r) => r && (r.error || r.ok === false));
if (malos.length > 0) problemas.push(`el flujo principal no pudo procesar el mensaje (${resumen(malos[0].error ?? 'ok = false')})`);

if (problemas.length > 0) throw new Error(`Secretaria · WhatsApp: ${problemas.join('; ')}`);
return [];
