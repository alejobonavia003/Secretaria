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

// Los archivos pedidos se mandan antes de soltar el turno; «Revisar envíos de archivos» solo los resume
const archivos = filas('Revisar envíos de archivos').find((r) => r && r.archivos_fallidos > 0);
if (archivos) problemas.push(`${archivos.archivos_fallidos} de ${archivos.archivos_total} mensajes de archivos no se enviaron (${archivos.archivos_error})`);

const ecos = filas('Enviar lo entendido');
const ecosFallidos = ecos.filter((r) => r && r.error);
if (ecosFallidos.length > 0) problemas.push(`${ecosFallidos.length} de ${ecos.length} mensajes de «lo que he entendido» no se enviaron (${resumen(ecosFallidos[0].error)})`);

// Si no se pudo anotar lo contestado, lo que llegó después espera hasta que caduque (TURNO_MIN)
const marcados = filas('Marcar contestados');
if (marcados.some((r) => r && r.error)) problemas.push(`no se pudo anotar como contestado (${resumen(marcados.find((r) => r && r.error).error)}); lo siguiente puede tardar en contestarse`);

const procesados = filas('Procesar mensaje');
// Solo un fallo de verdad del flujo principal (fallo_flujo: el modelo no respondió, Supabase o Drive dieron error). «No te he entendido» o
// «no he encontrado nada que cambiar» llevan un error anotado pero no lo son. Sin el campo (un flujo principal
// anterior, o el nodo falló entero), como antes: cualquier error.
const malos = procesados.filter((r) => r && ('fallo_flujo' in r ? r.fallo_flujo === true : r.error || r.ok === false));
if (malos.length > 0) problemas.push(`el flujo principal no pudo procesar el mensaje (${resumen(malos[0].error ?? 'ok = false')})`);
// «Anotar fallo» guarda también la pregunta de borrar en Drive: si no pudo, el «sí» del usuario no encontrará la pregunta (revisión del 2026-10-19)
const sinAnotar = procesados.filter((r) => r && r.anotado === false);
if (sinAnotar.length > 0) problemas.push('el flujo principal no pudo guardar en el mensaje su error o su pregunta (nodo «Anotar fallo»)');

if (problemas.length > 0) throw new Error(`Secretaria · WhatsApp: ${problemas.join('; ')}`);
return [];
