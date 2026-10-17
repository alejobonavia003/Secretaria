// Genera flujos/aviso-fallos.json (avisa por WhatsApp cuando otro flujo falla) a partir de:
//   - herramientas/flujo-avisos/*.js   código de los nodos Code
// Uso: node herramientas/generar-avisos.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.
// Se activa eligiéndolo como "Error workflow" en los ajustes de cada flujo que se quiere vigilar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'aviso-fallos.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Aviso de fallos';

const fallar = (msg) => {
  throw new Error(`generar-avisos: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

// Los nodos usan "return" al nivel superior y variables de n8n: se comprueba que compilan
function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', '$env', '$getWorkflowStaticData', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `5ec7e7a4-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const CFG = "$('Configuración').first().json.config";
const PASO = 240;

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-avisos', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

const envio = {
  method: 'POST',
  url: `=https://graph.facebook.com/{{ ${CFG}.graph_version }}/{{ ${CFG}.phone_number_id }}/messages`,
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendBody: true,
  specifyBody: 'json',
};

function construirFlujoBase() {
  const nodos = [
    { parameters: {}, id: id(1), name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0] },
    nodoCode(2, 'Configuración', [PASO, 0], 'configuracion.js'),
    nodoCode(3, 'Redactar aviso', [PASO * 2, 0], 'redactar.js'),
    // Sin plantilla de reserva (sin plantillas). Sin onError: si Meta rechaza el texto (lo habitual: la
    // ventana de 24 h está cerrada porque no has escrito a la secretaria en el último día) o el envío falla, la ejecución de ESTE flujo queda
    // en rojo y el fallo se ve en n8n: ya no hay otra vía.
    nodoHttp(
      4,
      'Enviar texto',
      [PASO * 3, 0],
      { ...envio, jsonBody: '={{ JSON.stringify($json.cuerpo_texto) }}' },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),

    nota(101, -40, -420, PASO * 2, 220, 4, '## ① Disparo y configuración\nSe ejecuta **solo** cuando otro flujo falla: hay que elegir este flujo como **Error workflow** en los ajustes de cada flujo vigilado (todos menos este y «Reiniciar todo»).\n**Configuración**: Phone number ID, enfriamiento y tope diario.'),
    nota(102, PASO * 2 - 40, -420, PASO * 2, 220, 5, '## ② Aviso\n**Redactar aviso** arma un mensaje corto con el flujo, el nodo y el error (sin cadenas largas que parezcan claves). Límite: un aviso por flujo cada 60 min y 10 al día; lo que se calla se cuenta en el siguiente.'),
    nota(103, PASO * 4 - 40, -420, PASO * 2, 220, 6, '## ③ Envío\nSolo **texto libre** (sin plantillas). Si Meta lo rechaza (ventana de 24 h cerrada: llevas más de un día sin escribir a la secretaria) o el envío falla, este flujo queda en rojo: solo se ve en n8n.'),
    nota(
      104,
      -40,
      300,
      PASO * 3,
      300,
      2,
      '## Antes de publicar\n1. Credencial **Header Auth de WhatsApp** (la misma del flujo de WhatsApp) en *Enviar texto*.\n2. Identificadores: `WHATSAPP_PHONE_NUMBER_ID` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. Publica este flujo y elígelo como **Error workflow** en los ajustes de los demás (Options > Settings).',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const cadena = ['Error Trigger', 'Configuración', 'Redactar aviso', 'Enviar texto'];
  const conexiones = {};
  for (let i = 0; i < cadena.length - 1; i++) conexiones[cadena[i]] = { main: [[a(cadena[i + 1])]] };

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
