// Genera flujos/limpieza-eventos.json (archiva los eventos que terminaron hace más de una semana; el flujo de Calendar los borra del
// calendario) a partir de:
//   - herramientas/flujo-limpieza/*.js   código de los nodos Code
// Uso: node herramientas/generar-limpieza.js
// Solo escribe el flujo de salida; no modifica ningún otro archivo.
//
// Los secretos no van en el JSON: las credenciales se eligen a mano al importar.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const ruta = (...p) => path.join(RAIZ, ...p);
const SALIDA = ruta('flujos', 'limpieza-eventos.json');
const { prepararImportacion } = require('./comun/importacion');
const NOMBRE_FLUJO = 'Secretaria · Limpieza de eventos';

const fallar = (msg) => {
  throw new Error(`generar-limpieza: ${msg}`);
};
const leer = (p) => {
  if (!fs.existsSync(p)) fallar(`no existe ${path.relative(RAIZ, p)}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
};

// Los nodos usan "return" al nivel superior y variables de n8n: se comprueba que compilan
function comprobarSintaxis(codigo, nodo) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$input', '$', codigo);
  } catch (e) {
    fallar(`el código de "${nodo}" no compila: ${e.message}`);
  }
}

const id = (n) => `5ec7e7a5-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
const PASO = 240;
const supabase = { authentication: 'predefinedCredentialType', nodeCredentialType: 'supabaseApi' };

function nodoCode(n, nombre, posicion, archivo) {
  const codigo = leer(ruta('herramientas', 'flujo-limpieza', archivo));
  comprobarSintaxis(codigo, nombre);
  return { parameters: { jsCode: codigo }, id: id(n), name: nombre, type: 'n8n-nodes-base.code', typeVersion: 2, position: posicion };
}

function nodoHttp(n, nombre, posicion, parametros, extra = {}) {
  return { parameters: { options: {}, ...parametros }, id: id(n), name: nombre, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: posicion, ...extra };
}

function nota(n, x, y, ancho, alto, color, contenido) {
  return { parameters: { content: contenido, height: alto, width: ancho, color }, id: id(n), name: `Nota ${n - 100}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y] };
}

function construirFlujoBase() {
  const nodos = [
    {
      // 3:00 de la zona del flujo (Europe/Madrid), todos los días
      parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 0 }] } },
      id: id(1),
      name: 'Cada día a las 3:00',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.4,
      position: [0, -120],
    },
    { parameters: {}, id: id(2), name: 'Disparador manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 120] },
    nodoCode(3, 'Configuración', [PASO, 0], 'configuracion.js'),
    nodoCode(4, 'Calcular límite', [PASO * 2, 0], 'calcular.js'),
    // Sin eventos antiguos devuelve cero filas y el flujo se pararía: Always Output Data lo evita (Planificar descarta el item vacío).
    // Si la lectura FALLA el flujo se detiene con error (no se usa continueRegularOutput) para que se vea.
    nodoHttp(5, 'Leer eventos antiguos', [PASO * 3, 0], { method: 'GET', url: '={{ $json.url_lectura }}', ...supabase }, { alwaysOutputData: true }),
    nodoCode(6, 'Planificar archivado', [PASO * 4, 0], 'planificar.js'),
    // Un solo PATCH. Sin onError: si falla, la ejecución queda en rojo (y el aviso de fallos puede avisar)
    nodoHttp(
      7,
      'Archivar',
      [PASO * 5, 0],
      {
        method: 'PATCH',
        url: '={{ $json.url }}',
        ...supabase,
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Prefer', value: 'return=representation' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.cuerpo) }}',
      },
      { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 },
    ),
    nodoCode(8, 'Resumen', [PASO * 6, 0], 'resumen.js'),

    nota(101, -40, -420, PASO * 2, 220, 4, '## ① Disparo y configuración\nSe ejecuta **cada día a las 3:00** (Europe/Madrid) o a mano (Disparador manual).\n**Configuración**: URL de Supabase, días de retención (7) y máximo por pasada (50).'),
    nota(102, PASO * 2 - 40, -420, PASO * 2, 220, 5, '## ② Eventos antiguos\n**Calcular límite** fija ahora − 7 días. **Leer eventos antiguos** trae los eventos pendientes o hechos cuyo **fin** pasó antes del límite (sin fin, su inicio), los más antiguos primero.'),
    nota(103, PASO * 4 - 40, -420, PASO * 3, 220, 6, '## ③ Archivar\n**Planificar archivado** vuelve a comprobar cada fila antes de tocar nada y arma UN `PATCH` que pasa los eventos a `archivado`. El flujo **Sincronizar Calendar** borra después de Google Calendar el evento de todo item archivado. El item no se borra de la base de datos.'),
    nota(
      104,
      -40,
      300,
      PASO * 3,
      280,
      2,
      '## Antes de publicar\n1. Credencial **Supabase API** en *Leer eventos antiguos* y *Archivar*.\n2. Identificadores: `SUPABASE_URL` en el `.env` del servidor (no hace falta tocar **Configuración**).\n3. Pruébalo con *Disparador manual*: mira en *Resumen* cuántos eventos archivó. La primera vez puede borrar de tu calendario todos los eventos antiguos acumulados (hasta 50 por pasada).\n4. Publica el flujo y elígelo en el aviso de fallos si quieres vigilarlo (Options > Settings > Error workflow).',
    ),
  ];

  const a = (nombre) => ({ node: nombre, type: 'main', index: 0 });
  const cadena = ['Configuración', 'Calcular límite', 'Leer eventos antiguos', 'Planificar archivado', 'Archivar', 'Resumen'];
  const conexiones = {
    'Cada día a las 3:00': { main: [[a('Configuración')]] },
    'Disparador manual': { main: [[a('Configuración')]] },
  };
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
