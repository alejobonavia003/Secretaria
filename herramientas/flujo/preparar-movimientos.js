// Nodo "Preparar movimientos": convierte el plan de «Revisar Drive» (meta mover_plan) en un item por carpeta que hay que mover.
// Si el plan pedía crear la carpeta de destino, «Crear en Drive» ya la ha creado: aquí se toma su id real y se pone como carpeta de destino de cada
// movimiento (el plan lo marca como «@nueva»). Si la creación falló, no se mueve nada.
//   un item por movimiento   { mover: { id, nuevo_padre_id, viejo_padre_id, nombre, ruta_origen, ruta_destino, archivos, subcarpetas } }
//   nada que mover           { sin_movimientos: true }   (todo rechazado, un error de todo el pedido o la creación falló)

function prepararMovimientos(plan, creado) {
  if (!plan || typeof plan !== 'object') return [{ sin_movimientos: true }];
  const movimientos = Array.isArray(plan.movimientos) ? plan.movimientos : [];
  let idNueva = null;
  if (plan.crear) {
    const ok = creado && !creado.error && creado.statusCode >= 200 && creado.statusCode < 300 && typeof creado.body?.id === 'string' && creado.body.id !== '';
    if (!ok) return [{ sin_movimientos: true }];
    idNueva = creado.body.id;
  }
  const items = movimientos.map((m) => ({ mover: { ...m, nuevo_padre_id: m.nuevo_padre_id === '@nueva' ? idNueva : m.nuevo_padre_id } })).filter((x) => typeof x.mover.nuevo_padre_id === 'string' && x.mover.nuevo_padre_id !== '');
  return items.length > 0 ? items : [{ sin_movimientos: true }];
}

// --- Pegamento con n8n ---
const plan = $('Revisar Drive').first().json.mover_plan;
let creado = null;
if (plan && plan.crear) {
  try {
    creado = $('Crear en Drive').first().json;
  } catch (e) {
    creado = null;
  }
}
return prepararMovimientos(plan, creado).map((json) => ({ json }));
