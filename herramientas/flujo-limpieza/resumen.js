// Nodo "Resumen": deja constancia de cuántos eventos se archivaron (se ve en el historial de ejecuciones). Los eventos archivados dejan
// de existir en Google Calendar en los minutos siguientes: el flujo "Sincronizar Calendar" borra el evento de todo item archivado.

const planificados = $('Planificar archivado').first().json.planificados;
const archivados = $input.all().map((i) => i.json).filter((r) => r && typeof r.id === 'string');

return [
  {
    json: {
      planificados,
      archivados: archivados.length,
      // Los que cambiaron entre la lectura y la escritura no se tocan: solo se informa
      sin_tocar: Math.max(0, planificados - archivados.length),
      titulos: archivados.map((r) => String(r.titulo ?? '').slice(0, 60)),
    },
  },
];
