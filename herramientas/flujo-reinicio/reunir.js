// Nodo "Reunir y decidir": junta todo lo que habría que borrar y lo reparte.
//   - Drive: los hijos de la raíz que no se conservan y el contenido de las carpetas conservadas (a la papelera, no definitivo).
//   - Calendar: todos los eventos del calendario "Secretaria".
// Con CONFIRMAR vacío (modo ensayo) devuelve UN item con el informe y no se borra nada. Con "BORRAR TODO" devuelve una operación por item.
// Si alguna lista venía paginada se avisa (hay más de lo que se ve): se borra lo visto y se vuelve a ejecutar.

const config = $('Configuración').first().json.config;
const plan = $('Planificar raíz').all().map((i) => i.json);
const hijos = $('Leer contenido de las carpetas').all().map((i) => i.json);
const eventosResp = $('Leer eventos de Calendar').first().json;

const MAX_OPERACIONES = 3000;
const ops = [];
const vistos = new Set();
const anadir = (op) => {
  const clave = `${op.tipo}:${op.id}`;
  if (vistos.has(clave) || typeof op.id !== 'string' || op.id === '') return;
  vistos.add(clave);
  ops.push(op);
};

let incompleto = Boolean(plan[0]?.raiz_incompleta);
for (const p of plan) for (const f of p.para_papelera ?? []) anadir({ tipo: 'drive', id: f.id, nombre: f.nombre, donde: 'raíz' });

plan.forEach((p, i) => {
  if (p.inocua) return;
  const r = hijos[i] ?? {};
  if (r.nextPageToken) incompleto = true;
  for (const f of Array.isArray(r.files) ? r.files : []) anadir({ tipo: 'drive', id: f.id, nombre: f.name, donde: p.carpeta });
});

if (eventosResp?.nextPageToken) incompleto = true;
for (const e of Array.isArray(eventosResp?.items) ? eventosResp.items : []) {
  anadir({ tipo: 'calendar', id: e.id, nombre: e.summary || '(sin título)', donde: 'calendario' });
}

if (ops.length > MAX_OPERACIONES) {
  throw new Error(`Reunir y decidir: ${ops.length} operaciones (máximo ${MAX_OPERACIONES} de una vez). Bórralas a mano o divide el trabajo.`);
}

const cuenta = (t) => ops.filter((o) => o.tipo === t).length;
const informe = {
  drive_a_la_papelera: cuenta('drive'),
  eventos_de_calendar: cuenta('calendar'),
  carpetas_conservadas: plan.filter((p) => !p.inocua).map((p) => p.carpeta),
  incompleto,
  nota: incompleto ? 'Alguna lista venía paginada (hay más de lo que se ve): tras borrar, vuelve a ejecutar el flujo hasta que salgan 0.' : null,
};

if (!config.real) {
  return [{ json: { modo: 'ensayo', ...informe, ejemplos: ops.slice(0, 30).map((o) => `${o.tipo === 'drive' ? 'Drive' : 'Calendar'} · ${o.donde} · ${o.nombre}`) } }];
}
if (ops.length === 0) return [{ json: { modo: 'nada', ...informe } }];
return ops.map((o) => ({ json: { modo: 'real', ...o, ...informe } }));
