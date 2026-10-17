-- Carpetas pedidas y su estado. drive_pendiente = true: aún no existe entera en Drive; false: ya está (carpeta_id es la última).
select ruta, drive_pendiente, carpeta_id, created_at, updated_at from public.carpetas_pedidas order by created_at desc limit 20;
