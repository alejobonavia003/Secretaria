-- Solo lee: las 10 últimas tareas con hora de recordatorio y el estado de sus avisos.
-- recordar_en_madrid:   la hora del recordatorio (el aviso «a la hora»)
-- recordatorio_avisos:  los avisos ya enviados, en minutos antes ({60} = ya salió el de 1 hora antes; {60,30,0} = salieron los tres)
-- estado:               pasa a «hecho» solo tras el aviso «a la hora»
-- es_evento_en_calendar: debe ser false siempre (un recordatorio no se sincroniza con Calendar)
select
  left(titulo, 40) as titulo,
  estado,
  recordar_en at time zone 'Europe/Madrid' as recordar_en_madrid,
  recordatorio_avisos,
  calendar_event_id is not null as es_evento_en_calendar
from public.items
where recordar_en is not null
order by created_at desc
limit 10;
