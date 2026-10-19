-- VACÍA TODOS LOS DATOS de las trece tablas del proyecto: avisos_enviados (qué iba en cada aviso), llegadas (el orden de los mensajes), mensajes, items, proyectos, memoria (incluido el nombre de la secretaria), horario_fijo, archivos, carpetas_pedidas,
-- drive_arbol y registro_drive (la foto y el historial de «Vigilar Drive») y vigilantes_estado y registro_calendar (el estado y el historial de «Vigilar Calendar»),
-- y suelta el turno de la cola de mensajes (la tabla turno conserva su única fila).
-- IRREVERSIBLE: no hay copia. Conserva el esquema, las funciones, los triggers y los índices.
-- No toca Google Calendar ni Drive: para eso está el flujo de n8n «Secretaria · Reiniciar todo» (eventos de Calendar y archivos de Drive a la papelera).
-- Orden recomendado para empezar de cero: 0) DESACTIVA los flujos «Vigilar Drive» y «Vigilar Calendar» (si no, avisarían de que has «borrado» todo), 1) este SQL, 2) el flujo
-- «Reiniciar todo» en ensayo, 3) el flujo con BORRAR TODO, 4) vuelve a activarlos (la primera pasada de cada uno guarda su foto o su hora sin avisar de nada).
-- Una sola sentencia: así Postgres acepta vaciar tablas enlazadas por claves foráneas sin usar cascade.
-- truncate no dispara los triggers por fila: no se marca nada para Calendar ni Drive.
-- Tras esto, el primer mensaje que mandes por WhatsApp te preguntará cómo quieres llamar a la secretaria.
-- Ejecútalo entero, una vez. Termina con una tabla de recuentos: todos deben ser 0.
truncate table public.avisos_enviados, public.llegadas, public.mensajes, public.items, public.proyectos, public.memoria, public.horario_fijo, public.archivos, public.carpetas_pedidas, public.drive_arbol, public.registro_drive, public.vigilantes_estado, public.registro_calendar;
update public.turno set mensaje_id = null, hasta = null;
select (select count(*) from public.avisos_enviados) as avisos_enviados,
  (select count(*) from public.llegadas) as llegadas,
  (select count(*) from public.horario_fijo) as horario_fijo,
  (select count(*) from public.mensajes) as mensajes,
  (select count(*) from public.items) as items,
  (select count(*) from public.proyectos) as proyectos,
  (select count(*) from public.memoria) as memoria,
  (select count(*) from public.archivos) as archivos,
  (select count(*) from public.carpetas_pedidas) as carpetas_pedidas,
  (select count(*) from public.drive_arbol) as drive_arbol,
  (select count(*) from public.registro_drive) as registro_drive,
  (select count(*) from public.vigilantes_estado) as vigilantes_estado,
  (select count(*) from public.registro_calendar) as registro_calendar,
  (select count(*) from public.turno where mensaje_id is not null) as turno_ocupado;
