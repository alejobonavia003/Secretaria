-- Actualización de la base de datos de la versión 1.1 a la 1.2. Solo si ya tenías instalada la 1.1: una instalación nueva usa
-- instalar.sql, que ya lo incluye (y si vienes de la 1.0, ejecuta antes actualizar-1.1.sql). Ejecútala UNA vez en el SQL Editor de
-- Supabase; si algo falla, no se aplica nada (una sola transacción).
--   - Horario fijo semanal (tabla horario_fijo y función quitar_horario): la secretaria avisa si una cita cae dentro.
--   - Todo se contesta en el orden de llegada, también fotos, documentos y audios (tabla llegadas; funciones registrar_llegadas,
--     turno_respuesta, marcar_contestados y llegada_perdida; reclamar_mensajes cambia: ordena por la llegada y gana un parámetro).
-- No cambia ni borra datos. Después, comprueba con comprobar-instalacion.sql (10 filas con ok = true).
-- Para deshacerla, la reversión está al final, comentada.

begin;

do $$
begin
  if to_regprocedure('public.olvidar_memoria(uuid)') is null then
    raise exception 'No encuentro la versión 1.1: ejecuta antes actualizar-1.1.sql';
  end if;
  if to_regclass('public.horario_fijo') is not null or to_regclass('public.llegadas') is not null then
    raise exception 'Esta actualización ya está aplicada: no la repitas';
  end if;
end;
$$;

create table public.horario_fijo (
  id uuid primary key default gen_random_uuid(),
  titulo text not null constraint horario_fijo_titulo_valido check (char_length(btrim(titulo)) between 1 and 60),
  -- Para no repetir el mismo bloque («Trabajo» y «trabajo» son el mismo)
  titulo_norm text generated always as (lower(btrim(titulo))) stored,
  -- 1 = lunes … 7 = domingo (ISO 8601, como extract(isodow …))
  dia_semana smallint not null constraint horario_fijo_dia_valido check (dia_semana between 1 and 7),
  hora_inicio time not null,
  hora_fin time not null,
  created_at timestamptz not null default now(),
  constraint horario_fijo_horas_validas check (hora_fin > hora_inicio),
  constraint horario_fijo_unico unique (titulo_norm, dia_semana, hora_inicio, hora_fin)
);

comment on table public.horario_fijo is 'Horario semanal del usuario (trabajo, gimnasio…): un bloque por día. El flujo principal avisa si una cita cae dentro.';

alter table public.horario_fijo enable row level security;
revoke all on table public.horario_fijo from anon, authenticated;

create function public.quitar_horario(p_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fila public.horario_fijo%rowtype;
begin
  delete from public.horario_fijo where id = p_id returning * into v_fila;
  if not found then
    return jsonb_build_object('borrado', false);
  end if;
  return jsonb_build_object('borrado', true, 'titulo', v_fila.titulo, 'dia_semana', v_fila.dia_semana,
    'hora_inicio', to_char(v_fila.hora_inicio, 'HH24:MI'), 'hora_fin', to_char(v_fila.hora_fin, 'HH24:MI'));
end;
$$;

comment on function public.quitar_horario(uuid) is 'Para el flujo principal: borra un bloque del horario fijo y devuelve cuál.';

revoke all on function public.quitar_horario(uuid) from public, anon, authenticated;
grant execute on function public.quitar_horario(uuid) to service_role;

create table public.llegadas (
  wa_message_id text primary key constraint llegadas_id_valido check (char_length(wa_message_id) <= 300 and wa_message_id ~ '^[A-Za-z0-9._=+/-]+$'),
  -- Hora del mensaje según Meta (campo timestamp del webhook, en segundos). Es la que ordena; si falta, la hora de registro.
  enviado_at timestamptz not null,
  -- Orden de registro: desempata los mensajes del mismo segundo
  orden bigint generated always as identity,
  tipo text not null constraint llegadas_tipo_valido check (tipo in ('texto', 'audio', 'imagen', 'documento', 'no_soportado')),
  contestado_at timestamptz,
  created_at timestamptz not null default now()
);

create index llegadas_sin_contestar_idx on public.llegadas (enviado_at, orden) where contestado_at is null;

comment on table public.llegadas is 'Orden de llegada de todos los mensajes (de cualquier tipo), para contestarlos en ese orden. Se vacía sola (2 días).';

alter table public.llegadas enable row level security;
revoke all on table public.llegadas from anon, authenticated;

create function public.registrar_llegadas(p_llegadas jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  delete from public.llegadas where created_at < now() - interval '2 days';
  if p_llegadas is null or jsonb_typeof(p_llegadas) <> 'array' then
    return 0;
  end if;
  insert into public.llegadas (wa_message_id, enviado_at, tipo)
  select e ->> 'wa_message_id',
         -- El timestamp de Meta son segundos Unix (texto). Uno que no lo parezca, o a más de un día de ahora, no se usa.
         case when (e ->> 'ts') ~ '^[0-9]{9,11}$' and abs(extract(epoch from now()) - (e ->> 'ts')::bigint) < 86400
              then to_timestamp((e ->> 'ts')::bigint) else now() end,
         case when e ->> 'tipo' in ('texto', 'audio', 'imagen', 'documento') then e ->> 'tipo' else 'no_soportado' end
    from jsonb_array_elements(p_llegadas) with ordinality as x(e, n)
   where jsonb_typeof(e) = 'object'
     and char_length(e ->> 'wa_message_id') <= 300 and (e ->> 'wa_message_id') ~ '^[A-Za-z0-9._=+/-]+$'
     and n <= 50
   order by n
  on conflict (wa_message_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Un texto o un audio que se registró pero nunca llegó a la tabla mensajes (falló «Guardar en cola»: Supabase caído, un 5xx) no se va a
-- contestar: deja de hacer esperar a los demás al minuto (un texto entra en la cola en el acto) o a los 5 minutos (un audio entra al acabar
-- de transcribirse, que puede tardar hasta unos 4). Sin esto bloquearía hasta que caducara (TURNO_MIN).
create function public.llegada_perdida(p_wa_message_id text, p_tipo text, p_creado timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_tipo in ('texto', 'audio')
     and p_creado < now() - case when p_tipo = 'texto' then interval '1 minute' else interval '5 minutes' end
     and not exists (select 1 from public.mensajes m where m.wa_message_id = p_wa_message_id);
$$;

create function public.marcar_contestados(p_ids text[])
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  update public.llegadas set contestado_at = now()
   where wa_message_id = any (coalesce(p_ids, '{}')) and contestado_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Para la respuesta de una foto, un documento, un audio rechazado o un aviso: ¿queda algo ANTERIOR sin contestar? Cuenta también lo que
-- espera en la cola de texto (si no, una foto podría adelantar a un texto anterior que espera su turno); eso no bloquea nada, porque
-- quien tiene el turno de la cola nunca espera aquí y la cola solo espera a lo ANTERIOR. Sin filas registradas para p_ids, 'enviar'.
create function public.turno_respuesta(p_ids text[], p_turno_min integer default 10, p_mismos text[] default '{}')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids text[] := coalesce(p_ids, '{}');
  v_limite timestamptz;
  v_primero record;
  v_ultimo record;
  v_esperar boolean;
  v_despues boolean;
begin
  if p_turno_min is null or p_turno_min < 1 or p_turno_min > 60 then
    raise exception 'turno_respuesta: p_turno_min debe estar entre 1 y 60';
  end if;
  v_limite := now() - make_interval(mins => p_turno_min);
  select enviado_at, orden into v_primero from public.llegadas where wa_message_id = any (v_ids) order by enviado_at, orden limit 1;
  if not found then
    return jsonb_build_object('accion', 'enviar', 'despues', false);
  end if;
  select enviado_at, orden into v_ultimo from public.llegadas where wa_message_id = any (v_ids) order by enviado_at desc, orden desc limit 1;

  select exists (
    select 1 from public.llegadas l
     where l.contestado_at is null and l.created_at > v_limite and not (l.wa_message_id = any (v_ids))
       and not (l.wa_message_id = any (coalesce(p_mismos, '{}')))
       and (l.enviado_at, l.orden) < (v_primero.enviado_at, v_primero.orden)
       and not public.llegada_perdida(l.wa_message_id, l.tipo, l.created_at)
  ) into v_esperar;
  select exists (
    select 1 from public.llegadas l
     where l.contestado_at is null and l.created_at > v_limite and not (l.wa_message_id = any (v_ids))
       and (l.enviado_at, l.orden) > (v_ultimo.enviado_at, v_ultimo.orden)
  ) into v_despues;

  return jsonb_build_object('accion', case when v_esperar then 'esperar' else 'enviar' end, 'despues', v_despues);
end;
$$;

-- reclamar_mensajes con un parámetro más (p_mismos): ordena por la posición de llegada y espera si hay un mensaje anterior sin contestar.
-- Al cambiar la firma hay que borrar la anterior (si no, quedarían dos funciones con el mismo nombre).
drop function public.reclamar_mensajes(uuid, integer);
create function public.reclamar_mensajes(p_mensaje_id uuid, p_turno_min integer default 10, p_mismos text[] default '{}')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_limite timestamptz;
  v_yo record;
  v_turno public.turno%rowtype;
  v_siguiente record;
  v_mensajes jsonb;
begin
  if p_turno_min is null or p_turno_min < 1 or p_turno_min > 60 then
    raise exception 'reclamar_mensajes: p_turno_min debe estar entre 1 y 60';
  end if;
  v_limite := now() - make_interval(mins => p_turno_min);
  -- Bloquea la fila del turno: dos reclamaciones nunca se cruzan
  select * into v_turno from public.turno where id = 1 for update;

  -- Lo que lleva demasiado en la cola es de una ejecución que murió: no se junta con lo nuevo
  update public.mensajes
     set en_cola = false, error = coalesce(error, 'Se quedó en la cola sin procesar (más de 15 minutos)')
   where en_cola and created_at < now() - interval '15 minutes';

  -- Posición de este mensaje: la de su llegada o, sin ella, su created_at
  select m.id, m.en_cola, m.wa_message_id, coalesce(l.enviado_at, m.created_at) as t, coalesce(l.orden, 0) as o
    into v_yo
    from public.mensajes m left join public.llegadas l on l.wa_message_id = m.wa_message_id
   where m.id = p_mensaje_id;
  if v_yo.id is null then
    raise exception 'reclamar_mensajes: no existe el mensaje %', p_mensaje_id;
  end if;
  if not v_yo.en_cola then
    return jsonb_build_object('accion', 'nada', 'motivo', 'ya_reclamado');
  end if;

  -- Un mensaje ANTERIOR sin contestar que no está en la cola (una foto que se sube, un audio que se transcribe, uno que se procesa):
  -- este espera a que se conteste
  if exists (
    select 1 from public.llegadas l
     where l.contestado_at is null and l.created_at > v_limite and l.wa_message_id <> v_yo.wa_message_id
       and not (l.wa_message_id = any (coalesce(p_mismos, '{}')))
       and (l.enviado_at, l.orden) < (v_yo.t, v_yo.o)
       and not exists (select 1 from public.mensajes m where m.wa_message_id = l.wa_message_id and m.en_cola)
       and not public.llegada_perdida(l.wa_message_id, l.tipo, l.created_at)
  ) then
    return jsonb_build_object('accion', 'esperar', 'motivo', 'anterior_sin_contestar');
  end if;

  -- El primer mensaje POSTERIOR sin contestar que no está en la cola: los de la cola que vienen después de él no se juntan con este
  select l.enviado_at as t, l.orden as o into v_siguiente
    from public.llegadas l
   where l.contestado_at is null and l.created_at > v_limite and l.wa_message_id <> v_yo.wa_message_id
     and not (l.wa_message_id = any (coalesce(p_mismos, '{}')))
     and (l.enviado_at, l.orden) > (v_yo.t, v_yo.o)
     and not exists (select 1 from public.mensajes m where m.wa_message_id = l.wa_message_id and m.en_cola)
     and not public.llegada_perdida(l.wa_message_id, l.tipo, l.created_at)
   order by l.enviado_at, l.orden
   limit 1;

  -- Si ha llegado otro después (sin nada entre medias), lo procesa la ejecución de ese último (que se lleva también este)
  if exists (
    select 1 from public.mensajes m left join public.llegadas l on l.wa_message_id = m.wa_message_id
     where m.en_cola and m.id <> p_mensaje_id
       and (coalesce(l.enviado_at, m.created_at), coalesce(l.orden, 0), m.created_at, m.id) > (v_yo.t, v_yo.o, (select created_at from public.mensajes where id = p_mensaje_id), p_mensaje_id)
       and (v_siguiente.t is null or (coalesce(l.enviado_at, m.created_at), coalesce(l.orden, 0)) < (v_siguiente.t, v_siguiente.o))
  ) then
    return jsonb_build_object('accion', 'nada', 'motivo', 'hay_uno_posterior');
  end if;

  -- Otra ejecución está procesando y su turno no ha caducado
  if v_turno.hasta is not null and v_turno.hasta > now() and v_turno.mensaje_id is distinct from p_mensaje_id then
    return jsonb_build_object('accion', 'esperar');
  end if;

  update public.turno set mensaje_id = p_mensaje_id, hasta = now() + make_interval(mins => p_turno_min) where id = 1;

  -- Se lleva todos los que esperan en la cola hasta este incluido (no hay nada anterior sin contestar fuera de la cola), en el orden en
  -- que llegaron. Los demás quedan como procesados por este.
  with posiciones as (
    select m.id, coalesce(l.enviado_at, m.created_at) as t, coalesce(l.orden, 0) as o
      from public.mensajes m left join public.llegadas l on l.wa_message_id = m.wa_message_id
     where m.en_cola
  ),
  reclamados as (
    update public.mensajes m
       set en_cola = false,
           agrupado_en = p_mensaje_id,
           procesado = case when m.id = p_mensaje_id then m.procesado else true end
      from posiciones p
     where p.id = m.id
       and (p.t, p.o, m.created_at, m.id) <= (v_yo.t, v_yo.o, (select created_at from public.mensajes where id = p_mensaje_id), p_mensaje_id)
    returning m.id, m.wa_message_id, m.tipo_entrada, m.texto_original, m.contexto_wa_id, m.created_at, p.t, p.o
  )
  select jsonb_agg(jsonb_build_object('id', id, 'wa_message_id', wa_message_id, 'tipo_entrada', tipo_entrada, 'texto', texto_original,
                                      'contexto_wa_id', contexto_wa_id, 'created_at', created_at)
                   order by t, o, created_at, id)
    into v_mensajes
    from reclamados;

  return jsonb_build_object('accion', 'procesar', 'mensajes', coalesce(v_mensajes, '[]'::jsonb));
end;
$$;

comment on function public.registrar_llegadas(jsonb) is 'Registra los mensajes recibidos, en orden, para contestarlos en ese orden. Borra los de más de 2 días.';
comment on function public.reclamar_mensajes(uuid, integer, text[]) is 'Cola de mensajes: devuelve {accion: nada|esperar|procesar, mensajes}. nada = ha llegado otro mensaje después (lo procesará esa ejecución, juntándolos) o ya estaba reclamado; esperar = otra ejecución tiene el turno o hay un mensaje anterior sin contestar fuera de la cola; procesar = toma el turno y se lleva, en orden de llegada, los mensajes en cola hasta este. Los que llevan más de 15 minutos en cola se sacan con un error.';
comment on function public.turno_respuesta(text[], integer, text[]) is 'Antes de contestar una foto, un documento o un aviso: {accion: enviar|esperar, despues}. esperar = queda un mensaje anterior sin contestar; despues = hay mensajes posteriores sin contestar (para citar el mensaje al que se responde).';
comment on function public.marcar_contestados(text[]) is 'Anota como contestados esos mensajes. Devuelve cuántos ha marcado.';

revoke all on function public.registrar_llegadas(jsonb) from public, anon, authenticated;
revoke all on function public.llegada_perdida(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.reclamar_mensajes(uuid, integer, text[]) from public, anon, authenticated;
revoke all on function public.turno_respuesta(text[], integer, text[]) from public, anon, authenticated;
revoke all on function public.marcar_contestados(text[]) from public, anon, authenticated;
grant execute on function public.registrar_llegadas(jsonb) to service_role;
grant execute on function public.llegada_perdida(text, text, timestamptz) to service_role;
grant execute on function public.reclamar_mensajes(uuid, integer, text[]) to service_role;
grant execute on function public.turno_respuesta(text[], integer, text[]) to service_role;
grant execute on function public.marcar_contestados(text[]) to service_role;

commit;

-- ===========================================================================
-- REVERSIÓN (comentada; solo si hay que volver a la 1.1). Devuelve reclamar_mensajes a su versión anterior: después de estas líneas,
-- copia de la versión 1.1 de supabase/instalar.sql esa función (desde «CREATE FUNCTION public.reclamar_mensajes» hasta su «$$;») y
-- añade «revoke all on function public.reclamar_mensajes(uuid, integer) from public, anon, authenticated;» y
-- «grant execute on function public.reclamar_mensajes(uuid, integer) to service_role;».
-- ===========================================================================
-- begin;
-- drop function public.marcar_contestados(text[]);
-- drop function public.llegada_perdida(text, text, timestamptz);
-- drop function public.turno_respuesta(text[], integer, text[]);
-- drop function public.reclamar_mensajes(uuid, integer, text[]);
-- drop function public.registrar_llegadas(jsonb);
-- drop table public.llegadas;
-- drop function public.quitar_horario(uuid);
-- drop table public.horario_fijo;
-- commit;
