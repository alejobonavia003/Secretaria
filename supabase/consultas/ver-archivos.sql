-- Solo lee: los 10 archivos más recientes, con su estado, su carpeta pedida y si están pendientes de moverse en Drive.
select nombre, estado, carpeta_destino, drive_pendiente, carpeta_id, respuesta_wa_id from public.archivos order by created_at desc limit 10;
