// Nodo "Quitar duplicados": deja pasar solo los mensajes que Supabase aún no tiene.
// Meta reintenta las entregas que no recibe confirmadas y puede enviar el mismo mensaje más de una vez; "Guardar mensaje"
// fallaría con un 409 (wa_message_id es único) y se contestaría "no he podido procesar" a algo que ya se atendió.
//
// Si la lectura de Supabase falla, NO se descarta nada: es preferible arriesgar un duplicado (que acabará en un error
// controlado) a perder un mensaje.

const recibidos = $('Separar mensajes').all().map((i) => i.json);
const respuesta = $input.all().map((i) => i.json);

const falloLectura = respuesta.some((r) => r && r.error);
const yaGuardados = new Set(respuesta.filter((r) => r && typeof r.wa_message_id === 'string').map((r) => r.wa_message_id));

const vistos = new Set();
const nuevos = [];
for (const m of recibidos) {
  if (!falloLectura && yaGuardados.has(m.wa_message_id)) continue; // ya procesado
  if (vistos.has(m.wa_message_id)) continue; // repetido dentro de la misma petición
  vistos.add(m.wa_message_id);
  const { consulta_url, ...resto } = m;
  nuevos.push({ json: resto });
}

return nuevos;
