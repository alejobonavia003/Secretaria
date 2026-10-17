// Nodo "Registrar": convierte la respuesta de Drive de cada acción en la actualización que hay que hacer en
// Supabase. La respuesta llega completa (statusCode, body) porque el nodo de Drive no falla ante errores HTTP.
//
// Cada escritura lleva una condición sobre updated_at (el valor que leyó "Leer pendientes"): si el archivo cambió
// mientras se movía, esa actualización no afecta a ninguna fila y el archivo sigue pendiente.

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const base = `${config.supabase_url}/rest/v1`;
const plan = $('Planificar').all().map((i) => i.json);
const respuestas = $input.all().map((i) => i.json);

const resumen = (cuerpo) => String(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo ?? '')).slice(0, 200);

const escrituras = [];
const fallos = [];
let hechas = 0;

respuestas.forEach((r, i) => {
  const p = plan[i];
  const estado = r.statusCode;
  if (!(estado >= 200 && estado < 300)) {
    const motivo = r.error ? String(r.error.message ?? r.error) : `HTTP ${estado} ${resumen(r.body)}`;
    fallos.push(`${p.etiqueta}: ${motivo}`);
    return;
  }
  hechas += 1;
  if (p.tipo === 'crear_carpeta') return; // nada que anotar: la pasada siguiente la encuentra por su nombre

  // Una carpeta pedida que ya existe entera: se limpia su marca y se guarda el id de la última carpeta de la ruta
  if (p.tipo === 'carpeta_lista') {
    escrituras.push({
      json: {
        etiqueta: p.etiqueta,
        metodo: 'PATCH',
        url: `${base}/carpetas_pedidas?id=eq.${encodeURIComponent(p.carpeta_pedida_id)}&updated_at=eq.${encodeURIComponent(p.updated_at)}`,
        cuerpo: { drive_pendiente: false, carpeta_id: p.carpeta_id },
        prefer: 'return=minimal',
      },
    });
    return;
  }

  // "limpiar" y "renombrar" no cambian la carpeta: carpeta_id no se incluye en el cuerpo
  const cuerpo = p.tipo === 'mover' ? { drive_pendiente: false, carpeta_id: p.carpeta_id } : { drive_pendiente: false };
  escrituras.push({
    json: {
      etiqueta: p.etiqueta,
      metodo: 'PATCH',
      url: `${base}/archivos?id=eq.${encodeURIComponent(p.archivo_id)}&updated_at=eq.${encodeURIComponent(p.updated_at)}`,
      cuerpo,
      prefer: 'return=minimal',
    },
  });
});

// Un fallo aislado se reintenta al minuto siguiente. Si no se ha podido hacer NADA (credencial caducada,
// Drive caído…) se avisa con un error para que la ejecución salga en rojo.
if (fallos.length > 0 && hechas === 0) {
  throw new Error(`Sincronizar Drive: ${fallos.length} fallo(s) y nada hecho. ${fallos.slice(0, 3).join(' | ')}`);
}

return escrituras;
