-- Solo lee: qué versión de la base de datos tienes instalada. Úsala antes de actualizar para saber qué scripts de supabase/ te faltan.
-- Termina con una tabla: cada versión y si está (true) o falta (false). Si la última que sale en true es la 1.0, ejecuta
-- actualizar-1.1.sql y después actualizar-1.2.sql; si es la 1.1, solo actualizar-1.2.sql. Con todas en true, está al día.
select * from (values
  ('1.0', 'instalación base (tabla avisos_enviados)', to_regclass('public.avisos_enviados') is not null),
  ('1.1', 'borrar en Drive y olvidar la memoria (marcar_borrado_drive y olvidar_memoria)',
    to_regprocedure('public.marcar_borrado_drive(text[])') is not null and to_regprocedure('public.olvidar_memoria(uuid)') is not null),
  ('1.2', 'horario fijo y orden de llegada (tablas horario_fijo y llegadas)',
    to_regclass('public.horario_fijo') is not null and to_regclass('public.llegadas') is not null)
) as t(version, que_mira, instalada)
order by version;
