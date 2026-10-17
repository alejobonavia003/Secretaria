// Prepara un flujo generado para importarlo sin tocar nada a mano:
//  - id fijo por flujo: reimportar actualiza el mismo flujo en lugar de crear otro, y los demás pueden apuntar a él;
//  - "Error workflow" ya elegido (el flujo «Aviso de fallos») en todos menos en el propio aviso;
//  - cada nodo que necesita credencial la referencia por NOMBRE. Al importar (n8n import:workflow, o al guardar el flujo), n8n busca
//    una credencial con ese nombre y ese tipo y, si hay exactamente una, la enlaza sola (replaceInvalidCredentials de n8n).
//    Por eso las credenciales se crean con estos nombres EXACTOS (docs/manual-instalacion.md). Gemini y WhatsApp son las dos del tipo
//    «Header Auth»: el nombre es lo que impide que se crucen.
const path = require('path');

const CREDENCIALES = {
  supabaseApi: 'Supabase',
  googleDriveOAuth2Api: 'Google Drive',
  googleCalendarOAuth2Api: 'Google Calendar',
  gemini: 'Gemini API key',
  whatsapp: 'WhatsApp token',
};

// Ids de 16 caracteres alfanuméricos, como los que genera n8n
const IDS = {
  'procesar-mensaje.json': 'secretariaPrinci',
  'whatsapp.json': 'secretariaWhatsa',
  'sincronizar-calendar.json': 'secretariaCalend',
  'sincronizar-drive.json': 'secretariaDriveS',
  'resumen-diario.json': 'secretariaResume',
  'aviso-fallos.json': 'secretariaAvisoF',
  'limpieza-eventos.json': 'secretariaLimpie',
  'avisos-eventos.json': 'secretariaEvento',
  'recordatorio-archivos.json': 'secretariaArchiv',
  'recordatorios.json': 'secretariaRecord',
  'reiniciar-todo.json': 'secretariaReinic',
  'vigilar-drive.json': 'secretariaVigDri',
  'vigilar-calendar.json': 'secretariaVigCal',
  'latido.json': 'secretariaLatido',
};

// Qué credencial necesita un nodo (null si ninguna)
function credencialDe(nodo) {
  const p = nodo.parameters || {};
  if (nodo.type === 'n8n-nodes-base.httpRequest') {
    if (p.authentication === 'predefinedCredentialType') return p.nodeCredentialType;
    if (p.authentication === 'genericCredentialType' && p.genericAuthType === 'httpHeaderAuth') {
      return /generativelanguage\.googleapis\.com/.test(JSON.stringify(p.url)) ? 'gemini' : 'whatsapp';
    }
    return null;
  }
  if (nodo.type === 'n8n-nodes-base.googleDrive') return 'googleDriveOAuth2Api';
  if (nodo.type === 'n8n-nodes-base.googleCalendar') return 'googleCalendarOAuth2Api';
  return null;
}

function prepararImportacion(flujo, salida) {
  const archivo = path.basename(salida);
  const id = IDS[archivo];
  if (!id) throw new Error(`importacion: falta el id fijo de ${archivo}`);
  for (const nodo of flujo.nodes) {
    const c = credencialDe(nodo);
    if (!c) continue;
    if (!CREDENCIALES[c]) throw new Error(`importacion: credencial desconocida «${c}» en el nodo ${nodo.name} de ${archivo}`);
    const tipo = c === 'gemini' || c === 'whatsapp' ? 'httpHeaderAuth' : c;
    nodo.credentials = { [tipo]: { id: null, name: CREDENCIALES[c] } };
  }
  // El subflujo que llama el de WhatsApp, ya elegido por su id fijo
  for (const nodo of flujo.nodes) {
    if (nodo.type === 'n8n-nodes-base.executeWorkflow' && nodo.name === 'Procesar mensaje') {
      nodo.parameters.workflowId = { __rl: true, mode: 'id', value: IDS['procesar-mensaje.json'] };
    }
  }
  const settings = { ...flujo.settings };
  if (archivo !== 'aviso-fallos.json') settings.errorWorkflow = IDS['aviso-fallos.json'];
  // id primero, para que se vea al abrir el JSON
  return { id, ...flujo, settings };
}

// Para las pruebas: las credenciales de un flujo son SOLO referencias por nombre (id nulo y un nombre de la lista), nunca ids ni valores
function credencialesSoloPorNombre(flujo) {
  const nombres = Object.values(CREDENCIALES);
  return flujo.nodes.every((n) => !n.credentials || Object.values(n.credentials).every((c) => c && c.id === null && nombres.includes(c.name) && Object.keys(c).length === 2));
}

module.exports = { prepararImportacion, credencialDe, credencialesSoloPorNombre, CREDENCIALES, IDS };
