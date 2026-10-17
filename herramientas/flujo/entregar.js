// Nodo "Entregar": devuelve al llamador (el flujo de WhatsApp) exactamente lo que calculó "Resultado".
// Existe porque después de "Resultado" puede ejecutarse "Anotar fallo" (un PATCH a Supabase cuya respuesta no sirve): el
// flujo llamado entrega la salida de su ÚLTIMO nodo, así que este nodo restablece la salida de siempre.
// Añade `anotado`: null si no había nada que anotar, true si la base de datos aceptó el error, false si no (queda en n8n).

const salida = $('Resultado').first().json;
let anotado = null;
if (salida.anotacion) {
  let r = null;
  try {
    r = $('Anotar fallo').first()?.json;
  } catch (e) {
    r = { error: 'Anotar fallo no se ejecutó' };
  }
  anotado = !(r && r.error);
}
return [{ json: { ...salida, anotado } }];
