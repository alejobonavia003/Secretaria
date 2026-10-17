// Nodo "Separar mensajes": ya respondido a Meta, deja un item por mensaje a atender.
// Si la decisión no era "procesar" (saludo, rechazo, nada que atender), no devuelve nada y el flujo termina aquí.
//
// El primer item lleva además "consulta_url": una sola lectura en Supabase de los wa_message_id ya guardados,
// para descartar los reenvíos de Meta (los mensajes se reintentan y pueden llegar repetidos).

const decision = $('Verificar').first().json;
if (decision.accion !== 'procesar') return [];

const mensajes = (decision.mensajes || []).filter((m) => m && typeof m.wa_message_id === 'string' && m.wa_message_id !== '');
// El id de un mensaje de WhatsApp es "wamid." más caracteres base64; se comprueba antes de ponerlo en una URL
const ids = mensajes.map((m) => m.wa_message_id).filter((id) => /^[A-Za-z0-9._=+\/-]{1,300}$/.test(id));
if (ids.length !== mensajes.length) throw new Error('Separar mensajes: un wa_message_id tiene caracteres no esperados');

return mensajes.map((m, i) => ({
  json: {
    ...m,
    consulta_url: i === 0 ? `/rest/v1/mensajes?select=wa_message_id&wa_message_id=in.(${ids.map((id) => `%22${encodeURIComponent(id)}%22`).join(',')})` : undefined,
  },
}));
