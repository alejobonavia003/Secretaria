// Nodo "Agrupar confirmaciones" (base de datos 1.4): un solo mensaje de guardado al mandar varios archivos.
// Meta suele entregar cada archivo en su propio aviso y n8n los procesa en ejecuciones distintas. Cada una, tras guardar su archivo, espera
// unos segundos («Esperar a más archivos») y llama a la función de Supabase «Reclamar confirmación de archivos»: se queda de forma atómica con
// TODOS los archivos aún sin confirmar (solo si ninguno se guardó hace un instante) y los marca como confirmados. Aquí:
//   - la ejecución que reclamó archivos manda UN mensaje con todos los nombres, y declara suyos los mensajes de todos los archivos
//     («contesta_todos»: así se marcan como contestados y su respuesta no espera a que alguien los conteste);
//   - las demás (sus archivos ya los reclamó otra) se callan: «agrupado», que «Preparar envío» ignora;
//   - un archivo que no se pudo registrar sigue teniendo su propio aviso;
//   - si la llamada falla (sin actualizar la base de datos a la 1.4, Supabase caído), cada archivo se confirma por su cuenta, como antes: mejor un aviso de más que ninguno;
//   - con ESPERA_ARCHIVOS_S = 0 en la Configuración, también como antes.

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const propios = $('Resultado archivo').all().map((i) => i.json);
const individuales = () => propios.map((json) => ({ json }));

if (!(Number(config.espera_archivos_s) > 0)) return individuales();

const respuesta = $input.all().map((i) => i.json);
// Un error de la llamada (la función no existe, Supabase no contesta) no es «no hay nada que reclamar»: se confirma cada uno por su cuenta
if (respuesta.some((j) => j && j.error)) return individuales();

const ID_DRIVE = /^[A-Za-z0-9_-]{10,100}$/;
const reclamados = [];
const vistos = new Set();
for (const j of respuesta) {
  if (!j || typeof j.drive_file_id !== 'string' || !ID_DRIVE.test(j.drive_file_id) || vistos.has(j.drive_file_id)) continue;
  vistos.add(j.drive_file_id);
  reclamados.push(j);
}

let mandado = false;
return propios.map((r) => {
  // Sin registrar: lleva su propio aviso (el archivo está en Drive pero no consta)
  if (r.registrado !== true) return { json: r };
  // Nada reclamado por esta ejecución (los reclamó otra, o aún están llegando más y lo hará el último): se calla
  if (reclamados.length === 0 || mandado) return { json: { agrupado: true, ok: true, responde_a: r.responde_a ?? null } };
  mandado = true;
  const ids = reclamados.map((c) => c.drive_file_id);
  const contesta = reclamados.map((c) => c.wa_message_id).filter((w) => typeof w === 'string' && w !== '');
  return {
    json: {
      mensajes: [MENSAJE_ARCHIVOS_GUARDADOS(reclamados.map((c) => c.nombre))],
      responde_a: r.responde_a ?? null,
      // Un solo archivo: el id de siempre. Varios: todos, para que responder a este mensaje los clasifique a todos
      ...(ids.length === 1 ? { archivo_drive_id: ids[0] } : { archivo_drive_ids: ids }),
      contesta_todos: contesta,
    },
  };
});
