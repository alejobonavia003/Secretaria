-- Muestra los eventos pendientes con sus horas en hora de Madrid (el editor de tablas de Supabase las enseña en UTC).
-- Solo lee: no cambia nada. Se puede ejecutar cuantas veces haga falta.
select titulo, to_char(fecha_inicio at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as inicio_madrid, to_char(fecha_fin at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as fin_madrid, (fecha_fin - fecha_inicio) as duracion, calendar_pendiente, estado from public.items where tipo = 'evento' order by fecha_inicio;
