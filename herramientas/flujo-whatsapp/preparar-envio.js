// Nodo "Preparar envío": un item por mensaje de WhatsApp que hay que mandar, siempre al número permitido.
// Llega por dos ramas:
//   - lo que devuelve el flujo principal (campo "mensajes", un elemento por mensaje; ya partidos a menos de 3.800 caracteres)
//   - un tipo de mensaje que todavía no se entiende (imagen, audio…): respuesta honesta, sin pasar por el modelo
// Si el flujo principal falló y no devolvió "mensajes", se avisa en lugar de callar.
// Si el flujo principal dice "agrupado" (no se usa desde que la cola vive en este flujo, pero se respeta), no se contesta nada.

/*__COMUN__*/

// --- Pegamento con n8n ---
const para = soloDigitos($env.WHATSAPP_NUMERO_PERMITIDO);
if (!para) throw new Error('Preparar envío: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const LIMITE_WHATSAPP = 4096; // caracteres por mensaje de texto en la API de Meta

// El texto que se procesó en esta ejecución, para decir cuál falló. Se busca el mensaje de esta ejecución (emparejado por posición con el item
// que entró en «Procesar mensaje»); si no se puede, y solo hay uno, ese. Sin texto, el mensaje genérico.
function textoDeEsteMensaje(i) {
  try {
    const t = $('Juntar mensajes').itemMatching(i)?.json?.mensaje;
    if (typeof t === 'string' && t.trim() !== '') return t;
  } catch (e) {
    // sin emparejamiento
  }
  try {
    const todos = $('Juntar mensajes').all().map((x) => x.json).filter((j) => j && j.accion === 'procesar' && typeof j.mensaje === 'string');
    if (todos.length === 1) return todos[0].mensaje;
  } catch (e) {
    // este camino no pasó por la cola
  }
  return '';
}

const envios = [];
for (const [i, item] of $input.all().entries()) {
  const r = item.json || {};
  if (r.agrupado === true && r.ok === true) continue;
  let textos;
  if (r.tipo_entrada === 'no_soportado') {
    textos = [MENSAJE_NO_SOPORTADO(r.tipo, r.cantidad)];
  } else if (Array.isArray(r.mensajes) && r.mensajes.some((t) => typeof t === 'string' && t.trim() !== '')) {
    textos = r.mensajes.filter((t) => typeof t === 'string' && t.trim() !== '');
  } else {
    textos = [mensajeFalloCanal(textoDeEsteMensaje(i))];
  }
  // Si el mensaje es la confirmación de un archivo recién guardado, el primer texto lleva el id de ese archivo en Drive:
  // "Anotar confirmación" lo usa para guardar el id del mensaje enviado (así el usuario puede clasificarlo respondiéndolo)
  const archivo = typeof r.archivo_drive_id === 'string' && r.archivo_drive_id !== '' ? r.archivo_drive_id : null;
  textos.forEach((t, n) => envios.push({ json: { para, texto: t.slice(0, LIMITE_WHATSAPP), ...(archivo && n === 0 ? { archivo_drive_id: archivo } : {}) } }));
}

return envios;
