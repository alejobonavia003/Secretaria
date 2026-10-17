// Genera flujos/recordatorio-archivos.json (el recordatorio por WhatsApp de los archivos que llevan días sin clasificar) a partir de:
//   - herramientas/flujo-archivos/*.js   código de los nodos Code
// Uso: node herramientas/generar-archivos.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'recordatorio-archivos.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Recordatorio de archivos';

const fallar = (msg) => {
  throw new Error(`generar-archivos: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

// Los nodos usan "return" al nivel superior y variables de n8n: se comprueba que compilan
function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', '$env', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `5ec7e7a6-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240;

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-archivos', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };

function construirFlujoBase() {
  const nodos = [
    {
      // 19:00 de la zona del flujo (Europe/Madrid), todos los días. n8n ajusta solo el cambio de hora de octubre y marzo.
      parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 19, triggerAtMinute: 0 }] } },
      id: id(1),
      name: 'Cada día a las 19:00',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.4,
      position: [0, -120],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 120] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    // Archivos pendientes de clasificar que llevan más de la espera (24 h por defecto). Con cero resultados no se pararía el flujo
    // (Always Output Data) y "Filtrar archivos" decide. Si la lectura FALLA el flujo se detiene con error.
    nodoHttp(
      4,
      'Leer archivos antiguos',
      [PASO * 2, 0],
      {
        method: 'GET',
        url: `={{ ${CFG}.supabase_url }}/rest/v1/archivos?select=id,nombre,estado,created_at&estado=eq.pendiente&eliminado_at=is.null&created_at=lte.{{ new Date(Date.now() - ${CFG}.horas_espera * 3600000).toISOString() }}&order=created_at.asc&limit=200`,
        ...supabase,
      },
      { executeOnce: true, alwaysOutputData: true },
    ),
    nodoCode(5, 'Filtrar archivos', [PASO * 3, 0], 'filtrar.js'),
    // Último mensaje que has ESCRITO tú (los ids de WhatsApp empiezan por "wamid."): decide si la ventana de 24 h sigue abierta
    nodoHttp(6, 'Leer último mensaje', [PASO * 4, 0], { method: 'GET', url: `={{ ${CFG}.supabase_url }}/rest/v1/mensajes?select=created_at&wa_message_id=like.wamid.*&order=created_at.desc&limit=1`, ...supabase }, { executeOnce: true, alwaysOutputData: true }),
    nodoCode(7, 'Redactar recordatorio', [PASO * 5, 0], 'redactar.js'),
    // Sin onError: si Meta rechaza el envío la ejecución queda en rojo y se ve.
    nodoHttp(
      8,
      'Enviar WhatsApp',
      [PASO * 6, 0],
      {
        method: 'POST',
        url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/messages`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),

    nota(101, -40, -420, PASO * 2, 220, 4, '## ① Disparo y configuración\nSe ejecuta **cada día a las 19:00** (zona Europe/Madrid) o a mano (Disparador manual).\n**Configuración**: URL de Supabase, Phone number ID, espera (24 h) y ventana de 24 h.'),
    nota(102, PASO * 2 - 40, -420, PASO * 2, 220, 5, '## ② Qué recordar\nLee los archivos pendientes de clasificar que llevan más de 24 h y los revalida. Si no hay ninguno, el flujo termina sin hacer nada.'),
    nota(103, PASO * 4 - 40, -420, PASO * 3, 220, 6, '## ③ Mensaje y envío\nSolo se envía si escribiste hace menos de 23 h (texto libre; el resumen de las 7:00 ya los lista y no hay plantilla para este recordatorio). El mensaje explica cómo clasificarlos; tu respuesta pasa por el flujo principal como cualquier otra orden.'),
    nota(
      104,
      -40,
      300,
      PASO * 3,
      300,
      2,
      '## Antes de publicar\n1. Credencial **Supabase API** en *Leer archivos antiguos* y *Leer último mensaje*, y la **Header Auth de WhatsApp** (la misma del flujo de WhatsApp) en *Enviar WhatsApp*.\n2. Identificadores: `SUPABASE_URL` y `WHATSAPP_PHONE_NUMBER_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. Pruébalo con *Disparador manual* (con `HORAS_ESPERA = 1` si tienes archivos recientes) y publica el flujo.\n4. Elige «Secretaria · Aviso de fallos» como Error workflow.',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const conexiones = {
    'Cada día a las 19:00': { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
    Configuración: { main: [[a('Leer archivos antiguos')]] },
    'Leer archivos antiguos': { main: [[a('Filtrar archivos')]] },
    'Filtrar archivos': { main: [[a('Leer último mensaje')]] },
    'Leer último mensaje': { main: [[a('Redactar recordatorio')]] },
    'Redactar recordatorio': { main: [[a('Enviar WhatsApp')]] },
  };

  return { name: NOMBRE_FLUJO, nodes: nodos, connections: conexiones, pinData: {}, settings: { executionOrder: 'v1', timezone: 'Europe/Madrid' } };
}

function generar() {
  const flujo = construirFlujo();
  fs.writeFileSync(SALIDA, JSON.stringify(flujo, null, 2) + '\n', 'utf8');
  console.log(`Escrito ${path.relative(RAIZ, SALIDA)}: ${flujo.nodes.length} nodos.`);
}

// Ids fijos, credenciales por nombre, subflujo y Error workflow ya elegidos (herramientas/comun/importacion.js)
function construirFlujo() {
  return prepararImportacion(construirFlujoBase(), SALIDA);
}

module.exports = { construirFlujo, generar };

if (require.main === module) generar();
