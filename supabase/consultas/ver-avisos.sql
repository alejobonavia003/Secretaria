-- Solo lee: los 5 últimos eventos con el estado de su aviso por WhatsApp.
-- aviso_whatsapp_en:         cuándo se avisará (lo calcula el flujo "Sincronizar Calendar" al llevar el evento a Google; null = sin aviso)
-- aviso_whatsapp_enviado_at: cuándo se envió (null = aún no enviado)
-- calendar_event_id:         si ya está sincronizado con Google Calendar (null = todavía no)
select
  left(titulo, 40) as titulo,
  estado,
  fecha_inicio at time zone 'Europe/Madrid' as empieza_madrid,
  aviso_whatsapp_en at time zone 'Europe/Madrid' as avisar_a_las_madrid,
  aviso_whatsapp_enviado_at at time zone 'Europe/Madrid' as enviado_a_las_madrid,
  calendar_event_id is not null as en_calendar,
  calendar_pendiente
from public.items
where tipo = 'evento'
order by created_at desc
limit 5;
