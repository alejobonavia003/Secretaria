// Nodo "Redactar resumen": convierte lo pendiente en UN mensaje de WhatsApp y construye el cuerpo exacto de la petición a Meta.
//
// - Si el último mensaje tuyo es de hace menos de VENTANA_HORAS, la ventana de 24 h de Meta sigue abierta: se envía el resumen
//   completo como texto libre.
// - Si no, NO se envía nada (sin plantillas; Meta solo admite plantillas fuera de la ventana). Ese día
//   no hay resumen; «qué tengo pendiente» devuelve lo mismo cuando quieras.
// - Con la ventana abierta se envía siempre, aunque no haya nada ("No tienes nada pendiente").
// - Se redacta con código, nunca con el modelo: formato idéntico cada día y sin coste.
//
// Las funciones de formato de la lista (limpiar, dia, hora, bloqueArchivos, formatearLista…) son copia de las de
// herramientas/flujo/resultado.js; probar-resumen.js comprueba que dan el mismo texto que ellas.

const config = $('Configuración').first().json.config;
const LIMITE_MENSAJE = 3800; // WhatsApp admite 4096 caracteres por mensaje; margen para no rozarlo
const ZONA = 'Europe/Madrid';

// Los caracteres de formato de WhatsApp en un título romperían la negrita o la cursiva
const limpiar = (s) => String(s ?? '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

const fmtDia = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, weekday: 'short', day: 'numeric', month: 'short' });
const fmtDiaLargo = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'short' });
const fmtHora = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtClave = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });

function dia(iso) {
  const p = Object.fromEntries(fmtDia.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
}
function diaLargo(fecha) {
  const p = Object.fromEntries(fmtDiaLargo.formatToParts(fecha).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}`.replace(/\./g, '');
}
const hora = (iso) => fmtHora.format(new Date(iso));
// Día natural en Madrid, "2026-10-12": sirve para comparar "es hoy" sin líos de zona horaria
const claveDia = (iso) => fmtClave.format(new Date(iso));

const minuscula1 = (s) => (s.length > 1 && s[0] === s[0].toUpperCase() && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s);
const mayuscula1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const porFecha = (campo) => (a, b) => {
  if (!a[campo] && !b[campo]) return 0;
  if (!a[campo]) return 1;
  if (!b[campo]) return -1;
  return new Date(a[campo]) - new Date(b[campo]);
};

function agrupar(filas, clave) {
  const mapa = new Map();
  for (const f of filas) {
    const k = clave(f);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(f);
  }
  return mapa;
}

const MAX_ARCHIVOS_LISTA = 15;
function bloqueArchivos(archivos) {
  if (!archivos.length) return null;
  const enlace = (f) => (typeof f.drive_url === 'string' && f.drive_url ? `\n  ${f.drive_url}` : '');
  const lineas = archivos.slice(0, MAX_ARCHIVOS_LISTA).map((f) => `• ${limpiar(f.nombre)}${enlace(f)}`);
  if (archivos.length > MAX_ARCHIVOS_LISTA) lineas.push(`… y ${archivos.length - MAX_ARCHIVOS_LISTA} más`);
  return `*Archivos sin clasificar*\n${lineas.join('\n')}`;
}

// Bloques de texto (uno por sección) de lo pendiente que no es de hoy. Sin "No tienes nada pendiente": eso lo decide quien llama.
function bloquesDeLista(rows, archivos) {
  // Alarma = tarea con hora de aviso y sin fecha límite: sección propia (igual que en «qué tengo pendiente»)
  const esAlarma = (r) => r.tipo === 'tarea' && r.recordar_en && !r.fecha_limite;
  const alarmas = rows.filter(esAlarma).sort(porFecha('recordar_en'));
  const sinAlarmas = rows.filter((r) => !esAlarma(r));
  // Las tareas y notas de un proyecto van aparte de lo cotidiano, como en «qué tengo pendiente»
  const deProyecto = sinAlarmas.filter((r) => r.proyecto && (r.tipo === 'tarea' || r.tipo === 'nota'));
  const cotidiano = sinAlarmas.filter((r) => !deProyecto.includes(r));
  const resto = cotidiano;
  const tareas = resto.filter((r) => r.tipo === 'tarea').sort(porFecha('fecha_limite'));
  const eventos = resto.filter((r) => r.tipo === 'evento').sort(porFecha('fecha_inicio'));
  const notas = resto.filter((r) => r.tipo === 'nota');
  const listas = resto.filter((r) => r.tipo === 'lista');
  const bloques = [];

  if (alarmas.length) {
    bloques.push(`*Alarmas*\n${alarmas.map((r) => `• 🔔 ${limpiar(r.titulo)}, ${dia(r.recordar_en)}, ${hora(r.recordar_en)}`).join('\n')}`);
  }
  if (tareas.length) {
    bloques.push(`*Tareas*\n${tareas.map((r) => `• ${limpiar(r.titulo)}${r.fecha_limite ? ` (${dia(r.fecha_limite)})` : ''}`).join('\n')}`);
  }
  if (deProyecto.length) {
    // Cada proyecto con su título y una viñeta por tarea o nota (nada de todo junto y con punto y coma), igual que en «qué tengo pendiente»
    const grupos = agrupar(deProyecto, (r) => limpiar(r.proyecto));
    const partes = [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es')).map((nombre) => {
      const lineas = grupos.get(nombre).slice().sort(porFecha('fecha_limite')).map((r) => `• ${r.tipo === 'nota' ? '📝 ' : ''}${limpiar(r.titulo)}${r.fecha_limite ? ` (${dia(r.fecha_limite)})` : ''}`);
      return `📁 *${nombre}*\n${lineas.join('\n')}`;
    });
    bloques.push(`*Proyectos*\n${partes.join('\n')}`);
  }
  if (eventos.length) {
    const lineas = eventos.map((r) => {
      const cuando = r.fecha_inicio ? `, ${dia(r.fecha_inicio)}, ${hora(r.fecha_inicio)}` : '';
      return `• ${limpiar(r.titulo)}${cuando}${r.proyecto ? ` [${limpiar(r.proyecto)}]` : ''}`;
    });
    bloques.push(`*Citas*\n${lineas.join('\n')}`);
  }
  if (notas.length) {
    bloques.push(`*Pensamientos*\n${notas.map((r) => `• ${limpiar(r.titulo)}`).join('\n')}`);
  }
  if (listas.length) {
    const grupos = agrupar(listas, (r) => limpiar(r.lista) || 'sin nombre');
    for (const nombre of [...grupos.keys()].sort((a, b) => a.localeCompare(b, 'es'))) {
      const elementos = grupos.get(nombre).map((r) => limpiar(r.titulo));
      bloques.push(`*Lista de ${nombre}*\n• ${mayuscula1(elementos.map(minuscula1).join(', '))}`);
    }
  }
  const deArchivos = bloqueArchivos(archivos);
  if (deArchivos) bloques.push(deArchivos);
  return bloques;
}

// --- Pegamento con n8n ---
const filasDe = (nombre, validar) => $(nombre).all().map((x) => x.json).filter((r) => r && validar(r));
const itemsLeidos = filasDe('Leer pendientes', (r) => typeof r.tipo === 'string' && typeof r.titulo === 'string');
const archivos = filasDe('Leer archivos', (r) => typeof r.nombre === 'string' && typeof r.created_at === 'string');
const ultimo = filasDe('Leer último mensaje', (r) => typeof r.created_at === 'string').map((r) => new Date(r.created_at)).filter((d) => !Number.isNaN(d.getTime()))[0];

const para = String($env.WHATSAPP_NUMERO_PERMITIDO ?? '').replace(/\D/g, '');
if (!para) throw new Error('Redactar resumen: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

const ahora = new Date();
const hoyClave = claveDia(ahora.toISOString());

// Eventos ya terminados: no cuentan (como en la consulta normal)
const rows = itemsLeidos.filter((r) => !(r.tipo === 'evento' && new Date(r.fecha_fin ?? r.fecha_inicio ?? '9999-12-31') < ahora));

const hoyEventos = rows.filter((r) => r.tipo === 'evento' && r.fecha_inicio && claveDia(r.fecha_inicio) === hoyClave).sort(porFecha('fecha_inicio'));
const hoyTareas = rows.filter((r) => r.tipo === 'tarea' && r.fecha_limite && claveDia(r.fecha_limite) === hoyClave).sort(porFecha('fecha_limite'));
const atrasadas = rows.filter((r) => r.tipo === 'tarea' && r.fecha_limite && claveDia(r.fecha_limite) < hoyClave).sort(porFecha('fecha_limite'));
const yaMostrados = new Set([...hoyEventos, ...hoyTareas, ...atrasadas]);
const resto = rows.filter((r) => !yaMostrados.has(r));

// --- Texto completo ---
const cabecera = `Buenos días. Esto es lo que tienes (${diaLargo(ahora)}):`;
const bloques = [];
if (hoyEventos.length || hoyTareas.length) {
  bloques.push(`*Hoy*\n${[...hoyEventos.map((r) => `• ${limpiar(r.titulo)}, ${hora(r.fecha_inicio)}`), ...hoyTareas.map((r) => `• ${limpiar(r.titulo)} (entrega hoy)`)].join('\n')}`);
}
if (atrasadas.length) {
  bloques.push(`*Atrasado*\n${atrasadas.map((r) => `• ${limpiar(r.titulo)} (era ${dia(r.fecha_limite)})`).join('\n')}`);
}
bloques.push(...bloquesDeLista(resto, archivos));

let texto;
if (bloques.length === 0) {
  texto = 'Buenos días. No tienes nada pendiente.';
} else {
  // Un solo mensaje: si no cabe, se corta por secciones y se avisa
  const AVISO = '… Hay más: escríbeme «qué tengo pendiente».';
  let cuerpo = cabecera;
  let omitidos = 0;
  for (const b of bloques) {
    if (omitidos === 0 && `${cuerpo}\n\n${b}`.length <= LIMITE_MENSAJE - AVISO.length - 2) cuerpo = `${cuerpo}\n\n${b}`;
    else omitidos += 1;
  }
  if (omitidos > 0 && cuerpo === cabecera) cuerpo = `${cabecera}\n\n${bloques[0].slice(0, LIMITE_MENSAJE - AVISO.length - cabecera.length - 10).trimEnd()}`;
  texto = omitidos > 0 ? `${cuerpo}\n\n${AVISO}` : cuerpo;
}

// --- Ventana de 24 h: solo texto libre ---
const ventanaMs = config.ventana_horas * 3600 * 1000;
const ventanaAbierta = Boolean(ultimo) && ahora.getTime() - ultimo.getTime() < ventanaMs;
// Con la ventana cerrada Meta solo admitiría una plantilla, y no se usan: ese día no se manda el resumen (no es un fallo)
if (!ventanaAbierta) return [];

const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: para };
return [{ json: { modo: 'texto', cuerpo: { ...base, type: 'text', text: { preview_url: false, body: texto } }, texto_completo: texto } }];
