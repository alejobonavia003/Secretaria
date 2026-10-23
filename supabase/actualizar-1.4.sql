-- Actualización de la base de datos a la versión 1.4. Solo si ya tenías instalada la 1.2 o la 1.3 (la base de datos es la misma en las dos):
-- una instalación nueva usa instalar.sql, que ya lo incluye. Si vienes de la 1.0 o la 1.1, ejecuta antes actualizar-1.1.sql y actualizar-1.2.sql.
-- Ejecútala UNA vez en el SQL Editor de Supabase; si algo falla, no se aplica nada (una sola transacción).
--   - Respuestas citadas: dos columnas nuevas en mensajes (respuesta_wa_ids, respuesta_texto) para entender a qué se refiere el usuario
--     cuando cita una respuesta de la secretaria.
--   - «Deshaz»: columna items.quitado_en, para recuperar lo que se quita por WhatsApp.
--   - Un solo aviso al guardar varios archivos: columna archivos.confirmado_at y función reclamar_confirmacion_archivos().
--   - Mover una carpeta dentro de otra: función mover_carpeta_drive().
-- No borra datos. Después, comprueba con comprobar-instalacion.sql (10 filas con ok = true) y mira la versión con consultas/ver-version.sql.
-- Para deshacerla, la reversión está al final, comentada.

begin;

do $$
begin
  if to_regclass('public.llegadas') is null then
    raise exception 'No encuentro la versión 1.2: ejecuta antes actualizar-1.2.sql';
  end if;
  if to_regprocedure('public.mover_carpeta_drive(text, text, text, text)') is not null or to_regprocedure('public.reclamar_confirmacion_archivos(integer, integer)') is not null then
    raise exception 'Esta actualización ya está aplicada: no la repitas';
  end if;
end;
$$;

alter table public.mensajes
  add column respuesta_wa_ids text[],
  add column respuesta_texto text,
  add constraint mensajes_respuesta_texto_corto check (respuesta_texto is null or char_length(respuesta_texto) <= 1500);
alter table public.items add column quitado_en timestamptz;
alter table public.archivos add column confirmado_at timestamptz;
-- Lo que ya estaba guardado se confirmó uno a uno en su día: no se vuelve a confirmar
update public.archivos set confirmado_at = created_at where confirmado_at is null;

comment on column public.mensajes.respuesta_wa_ids is 'Ids de WhatsApp de los mensajes con los que la secretaria contestó a este mensaje (para entender a qué se refiere el usuario cuando cita una respuesta).';
comment on column public.mensajes.respuesta_texto is 'Lo que se le contestó al usuario (recortado), para dárselo al modelo cuando cita esa respuesta.';
comment on column public.items.quitado_en is 'Cuándo lo quitó (o completó) el usuario por WhatsApp. Sirve para recuperarlo con «deshaz». Vacío si no lo quitó él o si ya se recuperó.';
comment on column public.archivos.confirmado_at is 'Cuándo se le confirmó al usuario que el archivo se guardó (los avisos de varios archivos se juntan en un solo mensaje). Vacío = aún sin confirmar.';

create index mensajes_respuesta_wa_ids_idx on public.mensajes using gin (respuesta_wa_ids) where respuesta_wa_ids is not null;
create index items_quitado_en_idx on public.items (quitado_en desc) where quitado_en is not null;
create index archivos_sin_confirmar_idx on public.archivos (created_at) where confirmado_at is null;

create function public.reclamar_confirmacion_archivos(p_quieto_s integer default 3, p_ventana_min integer default 10)
returns table (drive_file_id text, nombre text, wa_message_id text)
language plpgsql
set search_path = ''
as $$
begin
  if p_quieto_s is null or p_quieto_s < 0 or p_quieto_s > 60 then
    raise exception 'p_quieto_s debe estar entre 0 y 60';
  end if;
  if p_ventana_min is null or p_ventana_min < 1 or p_ventana_min > 120 then
    raise exception 'p_ventana_min debe estar entre 1 y 120';
  end if;
  -- Si se guardó otro archivo hace menos de p_quieto_s segundos, todavía están llegando más: lo reclamará el último en guardarse
  if exists (
    select 1 from public.archivos a
     where a.confirmado_at is null and a.created_at > now() - make_interval(secs => p_quieto_s)
  ) then
    return;
  end if;
  -- Todos los sin confirmar de la ventana, de una sola vez: dos llamadas a la vez no se llevan el mismo archivo (la segunda espera al bloqueo
  -- de fila y, al reevaluar «confirmado_at is null», ya no encuentra nada)
  return query
    with r as (
      update public.archivos a
         set confirmado_at = now()
       where a.confirmado_at is null
         and a.created_at > now() - make_interval(mins => p_ventana_min)
      returning a.drive_file_id, a.nombre, a.mensaje_id, a.created_at
    )
    select r.drive_file_id, r.nombre, m.wa_message_id
      from r
      left join public.mensajes m on m.id = r.mensaje_id
     order by r.created_at, r.nombre;
end;
$$;

create function public.mover_carpeta_drive(p_id text, p_nuevo_padre_id text, p_ruta_origen text, p_ruta_destino text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_o text := p_ruta_origen;
  v_d text := p_ruta_destino;
  v_arbol integer := 0;
  v_archivos integer := 0;
  v_pedidas integer := 0;
  v_omitidos integer := 0;
begin
  if p_id is null or btrim(p_id) = '' then
    raise exception 'mover_carpeta_drive: falta el id de la carpeta';
  end if;
  if p_nuevo_padre_id is null or btrim(p_nuevo_padre_id) = '' then
    raise exception 'mover_carpeta_drive: falta el id de la carpeta de destino';
  end if;
  if not public.ruta_carpeta_valida(v_o) or not public.ruta_carpeta_valida(v_d) then
    raise exception 'mover_carpeta_drive: ruta no válida (de 1 a 3 niveles, sin barras invertidas ni "..")';
  end if;
  if lower(v_o) = lower(v_d) or starts_with(lower(v_d), lower(v_o) || '/') then
    raise exception 'mover_carpeta_drive: una carpeta no se puede mover dentro de sí misma';
  end if;
  -- Entrada y Notas las usa la secretaria para ordenar: no se mueven
  if lower(v_o) in ('entrada', 'notas') then
    raise exception 'mover_carpeta_drive: Entrada y Notas no se mueven';
  end if;

  -- La foto del árbol: la carpeta (nueva ruta y nuevo padre) y todo lo que cuelga de ella (nueva ruta)
  update public.drive_arbol d
     set ruta = v_d || substr(d.ruta, length(v_o) + 1),
         padre_id = case when d.drive_id = p_id then p_nuevo_padre_id else d.padre_id end,
         updated_at = now()
   where d.eliminado_at is null
     and (d.drive_id = p_id or starts_with(d.ruta, v_o || '/'));
  get diagnostics v_arbol = row_count;

  -- Los archivos clasificados en esa carpeta o dentro. Si la nueva ruta no es válida (más de 3 niveles), se deja y se cuenta
  update public.archivos a
     set carpeta_destino = v_d || substr(a.carpeta_destino, length(v_o) + 1)
   where a.carpeta_destino is not null
     and (a.carpeta_destino = v_o or starts_with(a.carpeta_destino, v_o || '/'))
     and public.ruta_carpeta_valida(v_d || substr(a.carpeta_destino, length(v_o) + 1));
  get diagnostics v_archivos = row_count;
  select v_omitidos + count(*) into v_omitidos
    from public.archivos a
   where a.carpeta_destino is not null
     and (a.carpeta_destino = v_o or starts_with(a.carpeta_destino, v_o || '/'));

  -- Las carpetas pedidas bajo la movida. Una fila eliminada que ya ocupa la ruta nueva se descarta; una viva que ya la ocupa deja a la antigua
  -- como eliminada (la del destino ya representa esa carpeta)
  delete from public.carpetas_pedidas q
   where q.eliminada_at is not null
     and exists (
       select 1 from public.carpetas_pedidas p
        where p.eliminada_at is null and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'))
          and q.ruta = v_d || substr(p.ruta, length(v_o) + 1)
     );
  update public.carpetas_pedidas p
     set eliminada_at = now(), drive_pendiente = false
   where p.eliminada_at is null
     and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'))
     and exists (select 1 from public.carpetas_pedidas q where q.id <> p.id and q.ruta = v_d || substr(p.ruta, length(v_o) + 1));
  update public.carpetas_pedidas p
     set ruta = v_d || substr(p.ruta, length(v_o) + 1)
   where p.eliminada_at is null
     and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'))
     and public.ruta_carpeta_valida(v_d || substr(p.ruta, length(v_o) + 1));
  get diagnostics v_pedidas = row_count;
  select v_omitidos + count(*) into v_omitidos
    from public.carpetas_pedidas p
   where p.eliminada_at is null and (p.ruta = v_o or starts_with(p.ruta, v_o || '/'));

  return jsonb_build_object('arbol', v_arbol, 'archivos', v_archivos, 'carpetas_pedidas', v_pedidas, 'omitidos', v_omitidos);
end;
$$;

comment on function public.mover_carpeta_drive(text, text, text, text) is 'Tras mover una carpeta en Drive, reescribe sus rutas en drive_arbol, archivos.carpeta_destino y carpetas_pedidas. Atómica y sin fallar por rutas que no encajan (las cuenta en omitidos). Solo service_role.';

revoke all on function public.reclamar_confirmacion_archivos(integer, integer) from public, anon, authenticated;
grant execute on function public.reclamar_confirmacion_archivos(integer, integer) to service_role;
revoke all on function public.mover_carpeta_drive(text, text, text, text) from public, anon, authenticated;
grant execute on function public.mover_carpeta_drive(text, text, text, text) to service_role;

commit;

-- ===========================================================================
-- REVERSIÓN (comentada; solo si hay que volver a la 1.3). Pierde las marcas de «confirmado», «quitado» y las respuestas citadas; no los datos.
-- ===========================================================================
-- begin;
-- drop function public.mover_carpeta_drive(text, text, text, text);
-- drop function public.reclamar_confirmacion_archivos(integer, integer);
-- drop index public.archivos_sin_confirmar_idx;
-- drop index public.items_quitado_en_idx;
-- drop index public.mensajes_respuesta_wa_ids_idx;
-- alter table public.archivos drop column confirmado_at;
-- alter table public.items drop column quitado_en;
-- alter table public.mensajes drop constraint mensajes_respuesta_texto_corto, drop column respuesta_texto, drop column respuesta_wa_ids;
-- commit;
