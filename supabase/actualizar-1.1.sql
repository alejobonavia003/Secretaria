-- Actualización de la base de datos de la versión 1.0 a la 1.1. Solo si instalaste la 1.0: una instalación nueva usa instalar.sql,
-- que ya lo incluye. Ejecútala UNA vez en el SQL Editor de Supabase; si algo falla, no se aplica nada (una sola transacción).
-- Añade dos funciones (borrar en Drive con confirmación y olvidar un dato de la memoria). No crea ni cambia tablas.
-- Después, comprueba con comprobar-instalacion.sql (10 filas con ok = true). Para deshacerla, la reversión está al final, comentada.

begin;

do $$
begin
  if to_regclass('public.avisos_enviados') is null then
    raise exception 'No encuentro la instalación de la versión 1.0: ejecuta antes instalar.sql';
  end if;
  if to_regprocedure('public.marcar_borrado_drive(text[])') is not null or to_regprocedure('public.olvidar_memoria(uuid)') is not null then
    raise exception 'Esta actualización ya está aplicada: no la repitas';
  end if;
end;
$$;

-- Borrar en Drive por WhatsApp: el flujo principal manda a la papelera lo que el usuario ha confirmado y llama a esta función para
-- dejarlo anotado. p_ids son los ids de Drive borrados y los de las carpetas que cuelgan de ellos. Marca como eliminado (sin borrar
-- filas) lo que hay en la foto de «Vigilar Drive» (esos ids y todo lo que cuelga de esas carpetas, por su ruta, para que el vigilante no
-- lo avise como un borrado a mano), los archivos registrados y las carpetas pedidas. Devuelve cuántas filas marcó de cada tabla.
create function public.marcar_borrado_drive(p_ids text[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids text[] := coalesce(array_remove(p_ids, null), '{}');
  v_carpetas text[];
  v_arbol integer := 0;
  v_archivos integer := 0;
  v_pedidas integer := 0;
begin
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('arbol', 0, 'archivos', 0, 'carpetas_pedidas', 0);
  end if;

  -- Las carpetas afectadas: las de p_ids y todas las que cuelgan de ellas según la foto (por la ruta: «Fotos/Viajes/…» cuelga de
  -- «Fotos/Viajes»; starts_with y no like, porque un nombre con «_» o «%» haría de comodín)
  select coalesce(array_agg(d.drive_id), '{}') into v_carpetas
  from public.drive_arbol d
  where d.tipo = 'carpeta'
    and exists (
      select 1 from public.drive_arbol c
      where c.tipo = 'carpeta' and c.drive_id = any (v_ids)
        and (d.drive_id = c.drive_id or starts_with(d.ruta, c.ruta || '/'))
    );
  v_carpetas := v_carpetas || v_ids;

  update public.drive_arbol d
  set eliminado_at = now(), updated_at = now()
  where d.eliminado_at is null
    and (
      d.drive_id = any (v_ids)
      or exists (
        select 1 from public.drive_arbol c
        where c.tipo = 'carpeta' and c.drive_id = any (v_ids) and starts_with(d.ruta, c.ruta || '/')
      )
    );
  get diagnostics v_arbol = row_count;

  update public.archivos a
  set eliminado_at = now(), drive_pendiente = false
  where a.eliminado_at is null
    and (a.drive_file_id = any (v_ids) or a.carpeta_id = any (v_carpetas));
  get diagnostics v_archivos = row_count;

  update public.carpetas_pedidas p
  set eliminada_at = now(), drive_pendiente = false
  where p.eliminada_at is null and p.carpeta_id = any (v_carpetas);
  get diagnostics v_pedidas = row_count;

  return jsonb_build_object('arbol', v_arbol, 'archivos', v_archivos, 'carpetas_pedidas', v_pedidas);
end;
$$;

comment on function public.marcar_borrado_drive(text[]) is 'Para el flujo principal: anota como eliminado lo que acaba de mandar a la papelera de Drive (foto de Vigilar Drive, archivos y carpetas pedidas, también lo que cuelga de las carpetas). No borra filas.';

-- Olvidar un dato de la memoria permanente («/forget 2»). Devuelve lo que borró ({borrado, termino, significado}) para que la respuesta
-- diga exactamente qué se olvidó. Nunca borra el nombre de la secretaria: eso se cambia, no se olvida.
create function public.olvidar_memoria(p_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fila public.memoria%rowtype;
begin
  delete from public.memoria
  where id = p_id and termino_norm <> 'nombre de la secretaria'
  returning * into v_fila;
  if not found then
    return jsonb_build_object('borrado', false);
  end if;
  return jsonb_build_object('borrado', true, 'termino', v_fila.termino, 'significado', v_fila.significado);
end;
$$;

comment on function public.olvidar_memoria(uuid) is 'Para el flujo principal: borra un dato de la memoria permanente y devuelve cuál. Nunca el nombre de la secretaria.';

revoke all on function public.marcar_borrado_drive(text[]) from public, anon, authenticated;
grant execute on function public.marcar_borrado_drive(text[]) to service_role;
revoke all on function public.olvidar_memoria(uuid) from public, anon, authenticated;
grant execute on function public.olvidar_memoria(uuid) to service_role;

commit;

-- ===========================================================================
-- REVERSIÓN (comentada; solo si hay que volver a la 1.0)
-- ===========================================================================
-- begin;
-- drop function public.olvidar_memoria(uuid);
-- drop function public.marcar_borrado_drive(text[]);
-- commit;
