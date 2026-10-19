-- Base de datos de la secretaria: instalación completa en un proyecto de Supabase VACÍO.
--
-- Cómo usarlo (docs/manual-instalacion.md, paso de Supabase):
--   Supabase > SQL Editor > New query > pega este archivo ENTERO (ábrelo en un editor y copia desde aquí, no desde
--   un chat) > Run. Debe terminar en "Success. No rows returned". Después ejecuta supabase/comprobar-instalacion.sql.
--
-- Todo va en una transacción: si algo falla, no se crea nada y se puede volver a ejecutar tal cual.
-- Seguridad: RLS activado en todas las tablas y sin permisos para los roles públicos (anon, authenticated).
-- n8n entra con la clave secreta (rol service_role), que es la única que puede leer y escribir.

begin;

-- Las funciones en SQL se crean antes que las tablas que usan: se comprueban al ejecutarse, no al crearse.
set local check_function_bodies = false;

CREATE TABLE public.items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mensaje_id uuid,
    tipo text NOT NULL,
    titulo text NOT NULL,
    contenido text,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    fecha_inicio timestamp with time zone,
    fecha_fin timestamp with time zone,
    fecha_limite timestamp with time zone,
    lista text,
    etiquetas text[] DEFAULT '{}'::text[] NOT NULL,
    archivo_url text,
    calendar_event_id text,
    confianza numeric(3,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    espera_archivo_hasta timestamp with time zone,
    calendar_pendiente boolean DEFAULT false NOT NULL,
    aviso_whatsapp_en timestamp with time zone,
    aviso_whatsapp_enviado_at timestamp with time zone,
    recordar_en timestamp with time zone,
    recordatorio_avisos smallint[] DEFAULT '{}'::smallint[] NOT NULL,
    proyecto text,
    CONSTRAINT items_aviso_enviado_implica_aviso CHECK (((aviso_whatsapp_enviado_at IS NULL) OR (aviso_whatsapp_en IS NOT NULL))),
    CONSTRAINT items_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'hecho'::text, 'archivado'::text]))),
    CONSTRAINT items_tipo_check CHECK ((tipo = ANY (ARRAY['evento'::text, 'tarea'::text, 'lista'::text, 'nota'::text])))
);

COMMENT ON COLUMN public.items.archivo_url IS 'Sin uso: los archivos de un item van en la tabla archivos.';

COMMENT ON COLUMN public.items.espera_archivo_hasta IS 'Hasta cuándo el item espera un archivo que lo acompañe ("te mando un documento con la nota").';

COMMENT ON COLUMN public.items.calendar_pendiente IS 'El evento necesita crearse, actualizarse o borrarse en Google Calendar. Lo activa el trigger items_calendar_pendiente; lo limpia el flujo Sincronizar Calendar.';

COMMENT ON COLUMN public.items.aviso_whatsapp_en IS 'Aviso urgente por WhatsApp (evento del mismo día o aviso en menos de 2 horas desde que se crea). Nulo = sin aviso. Lo calcula el sincronizador.';

COMMENT ON COLUMN public.items.aviso_whatsapp_enviado_at IS 'Cuándo se envió el aviso urgente. Nulo = pendiente de enviar.';

COMMENT ON COLUMN public.items.recordar_en IS 'Hora de un recordatorio corto (solo tareas). El flujo "Recordatorios" avisa por WhatsApp antes y a esa hora. No se sincroniza con Calendar.';

COMMENT ON COLUMN public.items.recordatorio_avisos IS 'Avisos del recordatorio ya enviados, en minutos antes de recordar_en (por ejemplo {60,30,0}). Se vacía si cambia recordar_en.';

COMMENT ON COLUMN public.items.proyecto IS 'Nombre del proyecto al que pertenece (o null). Un trigger lo escribe como en la tabla proyectos y crea el proyecto si no existe.';

CREATE FUNCTION public.anadir_contenido(p_ids uuid[], p_texto text) RETURNS SETOF public.items
    LANGUAGE sql
    SET search_path TO ''
    AS $$
  update public.items
     set contenido = case when contenido is null or btrim(contenido) = '' then btrim(p_texto) else contenido || E'\n' || btrim(p_texto) end
   where id = any (p_ids) and estado = 'pendiente' and btrim(coalesce(p_texto, '')) <> ''
  returning *;
$$;

COMMENT ON FUNCTION public.anadir_contenido(p_ids uuid[], p_texto text) IS 'Añade una línea al contenido de los items pendientes indicados (no lo sustituye). Devuelve los items cambiados.';

CREATE FUNCTION public.contexto_avisos(p_wa_message_id text, p_horas integer DEFAULT 12) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    -- Los elementos del aviso citado que siguen vivos (pendientes, o una alarma que ya sonó y quedó hecha)
    'citados', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', i.id, 'tipo', i.tipo, 'titulo', i.titulo, 'estado', i.estado, 'aviso', a.tipo,
          'fecha_inicio', i.fecha_inicio, 'fecha_fin', i.fecha_fin, 'recordar_en', i.recordar_en)
        order by coalesce(i.recordar_en, i.fecha_inicio), i.titulo)
      from public.avisos_enviados a
      join public.items i on i.id = a.item_id
      where nullif(p_wa_message_id, '') is not null
        and a.wa_message_id = p_wa_message_id
        and i.estado in ('pendiente', 'hecho')
    ), '[]'::jsonb),
    -- Alarmas que ya sonaron (aviso «a la hora» enviado) en las últimas p_horas: las 10 más recientes
    'recientes', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'tipo', r.tipo, 'titulo', r.titulo, 'estado', r.estado, 'recordar_en', r.recordar_en)
        order by r.recordar_en desc)
      from (
        select i.id, i.tipo, i.titulo, i.estado, i.recordar_en
        from public.items i
        where i.tipo = 'tarea' and i.estado = 'hecho' and i.recordar_en is not null
          and 0 = any (i.recordatorio_avisos)
          and i.recordar_en between now() - make_interval(hours => greatest(1, least(coalesce(p_horas, 12), 72))) and now()
        order by i.recordar_en desc
        limit 10
      ) r
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.contexto_avisos(p_wa_message_id text, p_horas integer) IS 'Para el flujo principal: los elementos del aviso de WhatsApp al que responde el usuario y las alarmas que sonaron hace poco. Solo lee.';

CREATE FUNCTION public.guardar_con_archivos(p_item jsonb, p_archivos jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_item public.items;
  v_total integer;
  v_asignados integer;
  v_estado text;
begin
  if jsonb_typeof(p_item) is distinct from 'object' then
    raise exception 'p_item debe ser un objeto';
  end if;
  if jsonb_typeof(p_archivos) is distinct from 'array' or jsonb_array_length(p_archivos) = 0 then
    raise exception 'p_archivos debe ser una lista con al menos un archivo';
  end if;
  v_total := jsonb_array_length(p_archivos);

  -- Sin estado, pendiente (como hasta ahora). Solo pendiente u hecho: cancelar un item es otra operación.
  v_estado := coalesce(nullif(btrim(p_item ->> 'estado'), ''), 'pendiente');
  if v_estado not in ('pendiente', 'hecho') then
    raise exception 'estado no admitido: % (solo pendiente o hecho)', v_estado;
  end if;

  insert into public.items (
    mensaje_id, tipo, titulo, contenido, estado, fecha_inicio, fecha_fin, fecha_limite, lista,
    etiquetas, confianza, espera_archivo_hasta
  )
  values (
    (p_item ->> 'mensaje_id')::uuid,
    p_item ->> 'tipo',
    p_item ->> 'titulo',
    p_item ->> 'contenido',
    v_estado,
    (p_item ->> 'fecha_inicio')::timestamptz,
    (p_item ->> 'fecha_fin')::timestamptz,
    (p_item ->> 'fecha_limite')::timestamptz,
    p_item ->> 'lista',
    case
      when jsonb_typeof(p_item -> 'etiquetas') = 'array' then array(select jsonb_array_elements_text(p_item -> 'etiquetas'))
      else '{}'::text[]
    end,
    (p_item ->> 'confianza')::numeric,
    (p_item ->> 'espera_archivo_hasta')::timestamptz
  )
  returning * into v_item;

  update public.archivos a
     set item_id = v_item.id,
         carpeta_destino = null,
         estado = 'asignado',
         nombre = coalesce(nullif(btrim(x.nombre), ''), a.nombre)
    from jsonb_to_recordset(p_archivos) as x (id uuid, nombre text)
   where a.id = x.id;
  get diagnostics v_asignados = row_count;

  if v_asignados <> v_total then
    raise exception 'Solo se encontraron % de % archivos: no se guarda nada', v_asignados, v_total;
  end if;

  return to_jsonb(v_item);
end;
$$;

COMMENT ON FUNCTION public.guardar_con_archivos(p_item jsonb, p_archivos jsonb) IS 'Crea un item (pendiente u hecho, según p_item.estado) y le cuelga los archivos dados en una sola transacción. Solo service_role. Devuelve el item.';

CREATE FUNCTION public.items_proyecto_canonico() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_nombre text;
begin
  if new.proyecto is null then
    return new;
  end if;
  new.proyecto := btrim(new.proyecto);
  if new.proyecto = '' then
    new.proyecto := null;
    return new;
  end if;
  select nombre into v_nombre from public.proyectos where nombre_norm = lower(new.proyecto);
  if v_nombre is null then
    insert into public.proyectos (nombre) values (new.proyecto) returning nombre into v_nombre;
  elsif new.estado = 'pendiente' then
    -- Algo pendiente en un proyecto cerrado lo vuelve a abrir
    update public.proyectos set estado = 'activo' where nombre = v_nombre and estado <> 'activo';
  end if;
  new.proyecto := v_nombre;
  return new;
end;
$$;

CREATE FUNCTION public.liberar_turno(p_mensaje_id uuid) RETURNS boolean
    LANGUAGE sql
    SET search_path TO ''
    AS $$
  with soltado as (
    update public.turno set mensaje_id = null, hasta = null where id = 1 and mensaje_id = p_mensaje_id returning 1
  )
  select exists (select 1 from soltado);
$$;

COMMENT ON FUNCTION public.liberar_turno(p_mensaje_id uuid) IS 'Suelta el turno si lo tiene ese mensaje. Devuelve si lo tenía.';

CREATE FUNCTION public.marcar_calendar_pendiente() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.tipo = 'evento' then
      new.calendar_pendiente := true;
    end if;
  elsif (new.tipo = 'evento' or new.calendar_event_id is not null)
        and (new.tipo is distinct from old.tipo
             or new.titulo is distinct from old.titulo
             or new.contenido is distinct from old.contenido
             or new.fecha_inicio is distinct from old.fecha_inicio
             or new.fecha_fin is distinct from old.fecha_fin
             or new.estado is distinct from old.estado) then
    new.calendar_pendiente := true;
    if new.tipo is distinct from old.tipo
       or new.fecha_inicio is distinct from old.fecha_inicio
       or new.fecha_fin is distinct from old.fecha_fin
       or new.estado is distinct from old.estado then
      new.aviso_whatsapp_en := null;
      new.aviso_whatsapp_enviado_at := null;
    end if;
  end if;
  return new;
end;
$$;

COMMENT ON FUNCTION public.marcar_calendar_pendiente() IS 'Marca un evento como pendiente de sincronizar con Calendar cuando se crea o cambia algo que se refleja allí. Anula su aviso urgente solo si cambia el tipo, las fechas o el estado.';

CREATE FUNCTION public.marcar_drive_pendiente_archivo() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.item_id is not null or new.carpeta_destino is not null then
      new.drive_pendiente := true;
    end if;
  elsif new.vigilado_at is distinct from old.vigilado_at then
    null;
  elsif (new.item_id is not null and new.item_id is distinct from old.item_id)
        or new.carpeta_destino is distinct from old.carpeta_destino
        or new.nombre is distinct from old.nombre then
    new.drive_pendiente := true;
  end if;
  return new;
end;
$$;

COMMENT ON FUNCTION public.marcar_drive_pendiente_archivo() IS 'Marca un archivo para moverlo o renombrarlo en Drive cuando se le asigna un item, cambia de item, se pide o cambia su carpeta de destino o cambia su nombre. No marca si la escritura cambia vigilado_at (cambio hecho a mano anotado por «Vigilar Drive»).';

CREATE FUNCTION public.normalizar_recordatorio() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Solo las tareas llevan recordatorio
  if new.tipo is distinct from 'tarea' then
    new.recordar_en := null;
  end if;
  -- Otra hora: los avisos ya enviados valían para la anterior
  if tg_op = 'UPDATE' and new.recordar_en is distinct from old.recordar_en then
    new.recordatorio_avisos := '{}';
  end if;
  if new.recordar_en is null then
    new.recordatorio_avisos := '{}';
  end if;
  return new;
end;
$$;

COMMENT ON FUNCTION public.normalizar_recordatorio() IS 'Mantiene la coherencia de los recordatorios: solo las tareas llevan recordar_en y cambiar la hora borra los avisos ya enviados.';

CREATE FUNCTION public.poner_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;

CREATE FUNCTION public.reclamar_mensajes(p_mensaje_id uuid, p_turno_min integer DEFAULT 10) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  v_creado timestamptz;
  v_en_cola boolean;
  v_turno public.turno%rowtype;
  v_mensajes jsonb;
begin
  if p_turno_min is null or p_turno_min < 1 or p_turno_min > 60 then
    raise exception 'reclamar_mensajes: p_turno_min debe estar entre 1 y 60';
  end if;
  -- Bloquea la fila del turno: dos reclamaciones nunca se cruzan
  select * into v_turno from public.turno where id = 1 for update;

  -- Lo que lleva demasiado en la cola es de una ejecución que murió: no se junta con lo nuevo
  update public.mensajes
     set en_cola = false, error = coalesce(error, 'Se quedó en la cola sin procesar (más de 15 minutos)')
   where en_cola and created_at < now() - interval '15 minutes';

  select created_at, en_cola into v_creado, v_en_cola from public.mensajes where id = p_mensaje_id;
  if v_creado is null then
    raise exception 'reclamar_mensajes: no existe el mensaje %', p_mensaje_id;
  end if;
  if not v_en_cola then
    return jsonb_build_object('accion', 'nada', 'motivo', 'ya_reclamado');
  end if;
  -- Si ha llegado otro después, lo procesa la ejecución de ese último (que se lleva también este)
  if exists (
    select 1 from public.mensajes
     where en_cola and id <> p_mensaje_id and (created_at, id) > (v_creado, p_mensaje_id)
  ) then
    return jsonb_build_object('accion', 'nada', 'motivo', 'hay_uno_posterior');
  end if;
  -- Otra ejecución está procesando y su turno no ha caducado
  if v_turno.hasta is not null and v_turno.hasta > now() and v_turno.mensaje_id is distinct from p_mensaje_id then
    return jsonb_build_object('accion', 'esperar');
  end if;

  update public.turno set mensaje_id = p_mensaje_id, hasta = now() + make_interval(mins => p_turno_min) where id = 1;

  -- Se lleva todos los que esperan (hasta este incluido), en el orden en que llegaron. Los demás quedan como procesados por este.
  with reclamados as (
    update public.mensajes
       set en_cola = false,
           agrupado_en = p_mensaje_id,
           procesado = case when id = p_mensaje_id then procesado else true end
     where en_cola and (created_at, id) <= (v_creado, p_mensaje_id)
    returning id, wa_message_id, tipo_entrada, texto_original, contexto_wa_id, created_at
  )
  select jsonb_agg(jsonb_build_object('id', id, 'wa_message_id', wa_message_id, 'tipo_entrada', tipo_entrada, 'texto', texto_original,
                                      'contexto_wa_id', contexto_wa_id, 'created_at', created_at)
                   order by created_at, id)
    into v_mensajes
    from reclamados;

  return jsonb_build_object('accion', 'procesar', 'mensajes', coalesce(v_mensajes, '[]'::jsonb));
end;
$$;

COMMENT ON FUNCTION public.reclamar_mensajes(p_mensaje_id uuid, p_turno_min integer) IS 'Cola de mensajes: devuelve {accion: nada|esperar|procesar, mensajes}. nada = ha llegado otro mensaje después (lo procesará esa ejecución, juntándolos); esperar = otra ejecución tiene el turno; procesar = toma el turno (fila única de turno, caduca en p_turno_min) y se lleva todos los mensajes en cola, en orden. Los que llevan más de 15 minutos en cola se sacan con un error.';

CREATE FUNCTION public.resumen_proyectos() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select coalesce(jsonb_agg(jsonb_build_object('nombre', p.nombre, 'estado', p.estado, 'pendientes', (
           select count(*) from public.items i where i.proyecto = p.nombre and i.estado = 'pendiente'
         )) order by p.estado = 'cerrado', lower(p.nombre)), '[]'::jsonb)
  from public.proyectos p;
$$;

CREATE FUNCTION public.ruta_carpeta_valida(ruta text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
  select ruta is not null
    and ruta ~ '^[^/\\[:cntrl:]]{1,60}(/[^/\\[:cntrl:]]{1,60}){0,2}$'
    and ruta !~ '(^|/)\.{1,2}(/|$)'
    and ruta !~ '(^|/)\s'
    and ruta !~ '\s(/|$)';
$_$;

COMMENT ON FUNCTION public.ruta_carpeta_valida(ruta text) IS 'Verdadero si es una ruta de carpeta admitida: de 1 a 3 niveles de 1 a 60 caracteres, sin barra invertida, caracteres de control, "." ni "..", y sin espacios en los extremos de un nivel.';

CREATE FUNCTION public.salud_sistema() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  select jsonb_build_object(
    'ahora', now(),
    'calendar_atascados', (
      select count(*) from public.items
      where calendar_pendiente and updated_at < now() - interval '15 minutes'
    ),
    'drive_atascados', (
      (select count(*) from public.archivos where drive_pendiente and eliminado_at is null and updated_at < now() - interval '30 minutes')
      + (select count(*) from public.carpetas_pedidas where drive_pendiente and eliminada_at is null and updated_at < now() - interval '30 minutes')
    ),
    -- Solo los que no tienen motivo anotado (los fallos con motivo ya se avisaron)
    'mensajes_sin_procesar', (
      select count(*) from public.mensajes
      where not procesado and error is null and created_at between now() - interval '2 hours' and now() - interval '3 minutes'
    ),
    'recordatorios_vencidos', (
      select count(*) from public.items
      where tipo = 'tarea' and estado = 'pendiente' and recordar_en is not null
        and recordar_en < now() - interval '15 minutes'
        and not (0 = any (recordatorio_avisos))
    ),
    'ultimo_mensaje', (select max(created_at) from public.mensajes where wa_message_id like 'wamid.%')
  );
$$;

COMMENT ON FUNCTION public.salud_sistema() IS 'Qué hay atascado ahora mismo (Calendar, Drive, mensajes sin procesar y sin motivo anotado, recordatorios vencidos). La lee el flujo «Latido». Solo lee.';

CREATE TABLE public.archivos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid,
    mensaje_id uuid,
    drive_file_id text NOT NULL,
    drive_url text NOT NULL,
    nombre text NOT NULL,
    tipo_mime text,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    pregunta_enviada_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_pendiente boolean DEFAULT false NOT NULL,
    carpeta_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    carpeta_destino text,
    respuesta_wa_id text,
    eliminado_at timestamp with time zone,
    vigilado_at timestamp with time zone,
    CONSTRAINT archivos_carpeta_destino_valida CHECK (((carpeta_destino IS NULL) OR ((carpeta_destino ~ '^[^/\\[:cntrl:]]{1,60}(/[^/\\[:cntrl:]]{1,60}){0,2}$'::text) AND (carpeta_destino !~ '(^|/)\.{1,2}(/|$)'::text) AND (carpeta_destino !~ '(^|/)\s'::text) AND (carpeta_destino !~ '\s(/|$)'::text)))),
    CONSTRAINT archivos_carpeta_implica_asignado CHECK (((carpeta_destino IS NULL) OR (estado = 'asignado'::text))),
    CONSTRAINT archivos_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'asignado'::text]))),
    CONSTRAINT archivos_item_implica_asignado CHECK (((item_id IS NULL) OR (estado = 'asignado'::text))),
    CONSTRAINT archivos_nombre_check CHECK ((btrim(nombre) <> ''::text))
);

COMMENT ON TABLE public.archivos IS 'Archivos recibidos. El contenido vive en Drive; aquí la referencia y su estado (pendiente/asignado).';

COMMENT ON COLUMN public.archivos.pregunta_enviada_at IS 'Nulo = aún no se ha preguntado al usuario por este archivo pendiente.';

COMMENT ON COLUMN public.archivos.drive_pendiente IS 'El archivo necesita moverse de carpeta en Drive. Lo activan los triggers archivos_drive_pendiente e items_drive_pendiente; lo limpia el flujo Sincronizar Drive.';

COMMENT ON COLUMN public.archivos.carpeta_id IS 'Id de la carpeta de Drive donde está ahora el archivo. Nulo = no se sabe.';

COMMENT ON COLUMN public.archivos.updated_at IS 'Última modificación. El sincronizador de Drive escribe con una condición sobre este valor.';

COMMENT ON COLUMN public.archivos.carpeta_destino IS 'Carpeta pedida por el usuario, como ruta bajo Secretaria/ (Fotos, Fotos/Viajes). Si existe, manda sobre la carpeta que saldría del item. Un archivo con carpeta está asignado.';

COMMENT ON COLUMN public.archivos.respuesta_wa_id IS 'Id del mensaje de WhatsApp con el que la secretaria confirmó haber guardado el archivo. El usuario clasifica el archivo respondiendo a ese mensaje.';

COMMENT ON COLUMN public.archivos.eliminado_at IS 'El archivo se borró a mano en Drive (papelera o definitivo). Lo anota el flujo «Vigilar Drive»; la fila no se borra. Nulo = existe.';

COMMENT ON COLUMN public.archivos.vigilado_at IS 'Última vez que «Vigilar Drive» anotó aquí un cambio hecho a mano (mover o renombrar). Mientras cambie con la fila, el trigger de «mover en Drive» no marca el archivo.';

CREATE TABLE public.avisos_enviados (
    wa_message_id text NOT NULL,
    item_id uuid NOT NULL,
    tipo text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT avisos_enviados_tipo_valido CHECK ((tipo = ANY (ARRAY['alarma'::text, 'cita'::text]))),
    CONSTRAINT avisos_enviados_wa_message_id_formato CHECK ((((char_length(wa_message_id) >= 1) AND (char_length(wa_message_id) <= 300)) AND (wa_message_id ~ '^[A-Za-z0-9._=+/-]+$'::text)))
);

COMMENT ON TABLE public.avisos_enviados IS 'Qué alarmas y citas iban en cada aviso de WhatsApp enviado. Sirve para saber a qué elemento se refiere el usuario cuando RESPONDE a un aviso.';

CREATE TABLE public.carpetas_pedidas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ruta text NOT NULL,
    drive_pendiente boolean DEFAULT true NOT NULL,
    carpeta_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    eliminada_at timestamp with time zone,
    CONSTRAINT carpetas_pedidas_ruta_valida CHECK (public.ruta_carpeta_valida(ruta))
);

COMMENT ON TABLE public.carpetas_pedidas IS 'Carpetas que el usuario ha pedido crear sin mover archivos. El flujo Sincronizar Drive las crea (un nivel por pasada) y limpia drive_pendiente.';

COMMENT ON COLUMN public.carpetas_pedidas.drive_pendiente IS 'La carpeta aún no está comprobada o creada en Drive. Se vuelve a activar si el usuario repite la petición.';

COMMENT ON COLUMN public.carpetas_pedidas.carpeta_id IS 'Id de la carpeta de Drive del último nivel de la ruta, cuando ya existe.';

COMMENT ON COLUMN public.carpetas_pedidas.eliminada_at IS 'La carpeta se borró a mano en Drive. Lo anota «Vigilar Drive». Pedir otra vez la carpeta la vuelve a activar.';

CREATE TABLE public.drive_arbol (
    drive_id text NOT NULL,
    tipo text NOT NULL,
    nombre text NOT NULL,
    padre_id text,
    ruta text NOT NULL,
    origen text DEFAULT 'base'::text NOT NULL,
    visto_at timestamp with time zone DEFAULT now() NOT NULL,
    eliminado_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_arbol_drive_id_check CHECK ((btrim(drive_id) <> ''::text)),
    CONSTRAINT drive_arbol_nombre_check CHECK ((btrim(nombre) <> ''::text)),
    CONSTRAINT drive_arbol_origen_check CHECK ((origen = ANY (ARRAY['base'::text, 'sistema'::text, 'manual'::text]))),
    CONSTRAINT drive_arbol_tipo_check CHECK ((tipo = ANY (ARRAY['carpeta'::text, 'archivo'::text])))
);

COMMENT ON TABLE public.drive_arbol IS 'Foto del árbol de Drive bajo Secretaria/ (carpetas y archivos con su ruta). «Vigilar Drive» la compara con Drive cada 5 minutos para detectar lo que el usuario hace a mano.';

COMMENT ON COLUMN public.drive_arbol.origen IS 'base = ya existía al empezar a vigilar; sistema = lo creó la secretaria; manual = lo creó el usuario.';

COMMENT ON COLUMN public.drive_arbol.eliminado_at IS 'No nulo = ya no está en Drive (papelera o borrado). Si reaparece (se recupera de la papelera) vuelve a nulo.';

CREATE TABLE public.memoria (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    termino text NOT NULL,
    significado text NOT NULL,
    termino_norm text GENERATED ALWAYS AS (lower(btrim(termino))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memoria_significado_check CHECK ((btrim(significado) <> ''::text)),
    CONSTRAINT memoria_termino_check CHECK ((btrim(termino) <> ''::text))
);

COMMENT ON TABLE public.memoria IS 'Términos que el usuario enseña a la secretaria. Se inyecta en cada llamada al modelo. Solo se escribe con confirmación del usuario.';

COMMENT ON COLUMN public.memoria.termino_norm IS 'Columna generada (minúsculas, sin espacios en los extremos). Clave para upsert con on_conflict=termino_norm.';

CREATE TABLE public.mensajes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wa_message_id text NOT NULL,
    tipo_entrada text NOT NULL,
    texto_original text,
    transcripcion text,
    media_url text,
    procesado boolean DEFAULT false NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pregunta text,
    hilo jsonb,
    pregunta_pendiente boolean DEFAULT false NOT NULL,
    en_cola boolean DEFAULT false NOT NULL,
    agrupado_en uuid,
    contexto_wa_id text,
    CONSTRAINT mensajes_hilo_es_lista CHECK (((hilo IS NULL) OR (jsonb_typeof(hilo) = 'array'::text))),
    CONSTRAINT mensajes_pregunta_pendiente_completa CHECK (((NOT pregunta_pendiente) OR ((pregunta IS NOT NULL) AND (hilo IS NOT NULL)))),
    CONSTRAINT mensajes_tipo_entrada_check CHECK ((tipo_entrada = ANY (ARRAY['texto'::text, 'audio'::text, 'imagen'::text, 'documento'::text])))
);

COMMENT ON COLUMN public.mensajes.pregunta IS 'Pregunta que la secretaria hizo al usuario al procesar este mensaje (intención aclarar).';

COMMENT ON COLUMN public.mensajes.hilo IS 'Conversación hasta la pregunta: lista de turnos {rol: user|model, texto}. Se devuelve al modelo cuando llega la respuesta.';

COMMENT ON COLUMN public.mensajes.pregunta_pendiente IS 'La pregunta espera respuesta. Se cierra al procesar el mensaje siguiente. La caducidad la aplica el flujo al leer.';

COMMENT ON COLUMN public.mensajes.en_cola IS 'Verdadero mientras el mensaje espera a que una ejecución lo reclame (reclamar_mensajes). Solo los de texto y audio del flujo principal.';

COMMENT ON COLUMN public.mensajes.agrupado_en IS 'Mensaje cuya ejecución procesó a este (junto con los que llegaron seguidos). Su resultado y su error están en esa fila.';

CREATE TABLE public.proyectos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre text NOT NULL,
    nombre_norm text GENERATED ALWAYS AS (lower(nombre)) STORED,
    estado text DEFAULT 'activo'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proyectos_estado_valido CHECK ((estado = ANY (ARRAY['activo'::text, 'cerrado'::text]))),
    CONSTRAINT proyectos_nombre_valido CHECK (((nombre = btrim(nombre)) AND ((length(nombre) >= 1) AND (length(nombre) <= 60)) AND (nombre !~ '[/\\[:cntrl:]]'::text)))
);

COMMENT ON TABLE public.proyectos IS 'Proyectos del usuario (tareas y notas agrupadas aparte de las cotidianas). items.proyecto apunta a nombre.';

CREATE TABLE public.registro_calendar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tipo text NOT NULL,
    event_id text NOT NULL,
    item_id uuid,
    titulo text NOT NULL,
    detalle jsonb DEFAULT '{}'::jsonb NOT NULL,
    notificado_at timestamp with time zone,
    clave text NOT NULL,
    CONSTRAINT registro_calendar_clave_check CHECK ((btrim(clave) <> ''::text)),
    CONSTRAINT registro_calendar_event_id_check CHECK ((btrim(event_id) <> ''::text)),
    CONSTRAINT registro_calendar_tipo_check CHECK ((tipo = ANY (ARRAY['evento_creado'::text, 'evento_eliminado'::text, 'evento_movido'::text, 'evento_renombrado'::text])))
);

COMMENT ON TABLE public.registro_calendar IS 'Historial de cambios hechos a mano en Google Calendar y detectados por «Vigilar Calendar». notificado_at nulo = pendiente de avisar por WhatsApp.';

COMMENT ON COLUMN public.registro_calendar.clave IS 'Única: tipo, id del evento y fecha de última modificación que da Google. Evita registrar dos veces el mismo cambio si el flujo se repite.';

CREATE TABLE public.registro_drive (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tipo text NOT NULL,
    drive_id text NOT NULL,
    nombre text NOT NULL,
    ruta_antes text,
    ruta_despues text,
    detalle jsonb DEFAULT '{}'::jsonb NOT NULL,
    notificado_at timestamp with time zone,
    clave text NOT NULL,
    CONSTRAINT registro_drive_clave_check CHECK ((btrim(clave) <> ''::text)),
    CONSTRAINT registro_drive_tipo_check CHECK ((tipo = ANY (ARRAY['carpeta_creada'::text, 'carpeta_eliminada'::text, 'carpeta_movida'::text, 'carpeta_renombrada'::text, 'carpeta_restaurada'::text, 'archivo_eliminado'::text, 'archivo_movido'::text, 'archivo_renombrado'::text, 'archivo_restaurado'::text])))
);

COMMENT ON TABLE public.registro_drive IS 'Historial de cambios hechos a mano en Drive y detectados por «Vigilar Drive». notificado_at nulo = pendiente de avisar por WhatsApp.';

COMMENT ON COLUMN public.registro_drive.clave IS 'Única: tipo, id de Drive y estado anterior de la foto. Evita registrar dos veces el mismo cambio si el flujo se repite.';

CREATE TABLE public.turno (
    id smallint DEFAULT 1 NOT NULL,
    mensaje_id uuid,
    hasta timestamp with time zone,
    CONSTRAINT turno_una_fila CHECK ((id = 1))
);

CREATE TABLE public.vigilantes_estado (
    clave text NOT NULL,
    valor jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vigilantes_estado_clave_check CHECK ((btrim(clave) <> ''::text))
);

COMMENT ON TABLE public.vigilantes_estado IS 'Lo que cada flujo «Vigilar …» recuerda entre pasadas. Para calendar: {"ultima": "<instante de la última pasada correcta>"}.';

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_drive_file_id_unico UNIQUE (drive_file_id);

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.avisos_enviados
    ADD CONSTRAINT avisos_enviados_pkey PRIMARY KEY (wa_message_id, item_id);

ALTER TABLE ONLY public.carpetas_pedidas
    ADD CONSTRAINT carpetas_pedidas_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.carpetas_pedidas
    ADD CONSTRAINT carpetas_pedidas_ruta_unica UNIQUE (ruta);

ALTER TABLE ONLY public.drive_arbol
    ADD CONSTRAINT drive_arbol_pkey PRIMARY KEY (drive_id);

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memoria
    ADD CONSTRAINT memoria_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memoria
    ADD CONSTRAINT memoria_termino_norm_unico UNIQUE (termino_norm);

ALTER TABLE ONLY public.mensajes
    ADD CONSTRAINT mensajes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mensajes
    ADD CONSTRAINT mensajes_wa_message_id_key UNIQUE (wa_message_id);

ALTER TABLE ONLY public.proyectos
    ADD CONSTRAINT proyectos_nombre_norm_unico UNIQUE (nombre_norm);

ALTER TABLE ONLY public.proyectos
    ADD CONSTRAINT proyectos_nombre_unico UNIQUE (nombre);

ALTER TABLE ONLY public.proyectos
    ADD CONSTRAINT proyectos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.registro_calendar
    ADD CONSTRAINT registro_calendar_clave_key UNIQUE (clave);

ALTER TABLE ONLY public.registro_calendar
    ADD CONSTRAINT registro_calendar_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.registro_drive
    ADD CONSTRAINT registro_drive_clave_key UNIQUE (clave);

ALTER TABLE ONLY public.registro_drive
    ADD CONSTRAINT registro_drive_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.turno
    ADD CONSTRAINT turno_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vigilantes_estado
    ADD CONSTRAINT vigilantes_estado_pkey PRIMARY KEY (clave);

CREATE INDEX archivos_drive_pendiente_idx ON public.archivos USING btree (updated_at) WHERE drive_pendiente;

CREATE INDEX archivos_item_idx ON public.archivos USING btree (item_id);

CREATE INDEX archivos_pendientes_idx ON public.archivos USING btree (created_at) WHERE (estado = 'pendiente'::text);

CREATE UNIQUE INDEX archivos_respuesta_wa_id_unico ON public.archivos USING btree (respuesta_wa_id) WHERE (respuesta_wa_id IS NOT NULL);

CREATE INDEX archivos_vivos_pendientes_idx ON public.archivos USING btree (created_at) WHERE ((estado = 'pendiente'::text) AND (eliminado_at IS NULL));

CREATE INDEX avisos_enviados_item_id_idx ON public.avisos_enviados USING btree (item_id);

CREATE INDEX carpetas_pedidas_pendientes_idx ON public.carpetas_pedidas USING btree (updated_at) WHERE drive_pendiente;

CREATE INDEX drive_arbol_vivos_idx ON public.drive_arbol USING btree (tipo) WHERE (eliminado_at IS NULL);

CREATE INDEX items_aviso_whatsapp_idx ON public.items USING btree (aviso_whatsapp_en) WHERE ((aviso_whatsapp_en IS NOT NULL) AND (aviso_whatsapp_enviado_at IS NULL));

CREATE UNIQUE INDEX items_calendar_event_id_unico ON public.items USING btree (calendar_event_id) WHERE (calendar_event_id IS NOT NULL);

COMMENT ON INDEX public.items_calendar_event_id_unico IS 'Un evento de Google Calendar corresponde como mucho a un item: un evento creado a mano nunca se importa dos veces.';

CREATE INDEX items_calendar_pendiente_idx ON public.items USING btree (updated_at) WHERE calendar_pendiente;

CREATE INDEX items_espera_archivo_idx ON public.items USING btree (espera_archivo_hasta) WHERE (espera_archivo_hasta IS NOT NULL);

CREATE INDEX items_fecha_limite_idx ON public.items USING btree (fecha_limite) WHERE (tipo = 'tarea'::text);

CREATE INDEX items_lista_idx ON public.items USING btree (lista) WHERE (tipo = 'lista'::text);

CREATE INDEX items_proyecto_idx ON public.items USING btree (proyecto) WHERE (proyecto IS NOT NULL);

CREATE INDEX items_recordar_en_idx ON public.items USING btree (recordar_en) WHERE ((recordar_en IS NOT NULL) AND (estado = 'pendiente'::text));

CREATE INDEX items_tipo_estado_idx ON public.items USING btree (tipo, estado);

CREATE INDEX mensajes_en_cola_idx ON public.mensajes USING btree (created_at) WHERE en_cola;

CREATE INDEX mensajes_pregunta_pendiente_idx ON public.mensajes USING btree (created_at) WHERE pregunta_pendiente;

CREATE INDEX registro_calendar_item_idx ON public.registro_calendar USING btree (item_id);

CREATE INDEX registro_calendar_sin_avisar_idx ON public.registro_calendar USING btree (created_at) WHERE (notificado_at IS NULL);

CREATE INDEX registro_drive_sin_avisar_idx ON public.registro_drive USING btree (created_at) WHERE (notificado_at IS NULL);

CREATE TRIGGER archivos_drive_pendiente BEFORE INSERT OR UPDATE ON public.archivos FOR EACH ROW EXECUTE FUNCTION public.marcar_drive_pendiente_archivo();

CREATE TRIGGER archivos_updated_at BEFORE UPDATE ON public.archivos FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER carpetas_pedidas_updated_at BEFORE UPDATE ON public.carpetas_pedidas FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER items_calendar_pendiente BEFORE INSERT OR UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.marcar_calendar_pendiente();

CREATE TRIGGER items_normalizar_recordatorio BEFORE INSERT OR UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.normalizar_recordatorio();

CREATE TRIGGER items_proyecto_canonico BEFORE INSERT OR UPDATE OF proyecto ON public.items FOR EACH ROW EXECUTE FUNCTION public.items_proyecto_canonico();

CREATE TRIGGER items_updated_at BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER memoria_updated_at BEFORE UPDATE ON public.memoria FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

CREATE TRIGGER proyectos_updated_at BEFORE UPDATE ON public.proyectos FOR EACH ROW EXECUTE FUNCTION public.poner_updated_at();

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.archivos
    ADD CONSTRAINT archivos_mensaje_id_fkey FOREIGN KEY (mensaje_id) REFERENCES public.mensajes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.avisos_enviados
    ADD CONSTRAINT avisos_enviados_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_mensaje_id_fkey FOREIGN KEY (mensaje_id) REFERENCES public.mensajes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_proyecto_fkey FOREIGN KEY (proyecto) REFERENCES public.proyectos(nombre) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.mensajes
    ADD CONSTRAINT mensajes_agrupado_en_fkey FOREIGN KEY (agrupado_en) REFERENCES public.mensajes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.registro_calendar
    ADD CONSTRAINT registro_calendar_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE SET NULL;

ALTER TABLE public.archivos ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.avisos_enviados ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.carpetas_pedidas ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.drive_arbol ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memoria ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mensajes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.proyectos ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.registro_calendar ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.registro_drive ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.turno ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.vigilantes_estado ENABLE ROW LEVEL SECURITY;

-- ============================================================================================================
-- Funciones que usan las tablas de arriba (van después de ellas porque declaran tipos de fila).

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

-- ============================================================================================================
-- Fila única del turno de la cola de mensajes (el flujo de WhatsApp la reclama y la suelta)
insert into public.turno (id) values (1);

-- ============================================================================================================
-- Seguridad. Supabase da por defecto permisos sobre lo que se crea en "public" a anon y authenticated: se quitan.
revoke all on table public.items from anon, authenticated;
revoke all on table public.archivos from anon, authenticated;
revoke all on table public.avisos_enviados from anon, authenticated;
revoke all on table public.carpetas_pedidas from anon, authenticated;
revoke all on table public.drive_arbol from anon, authenticated;
revoke all on table public.memoria from anon, authenticated;
revoke all on table public.mensajes from anon, authenticated;
revoke all on table public.proyectos from anon, authenticated;
revoke all on table public.registro_calendar from anon, authenticated;
revoke all on table public.registro_drive from anon, authenticated;
revoke all on table public.turno from anon, authenticated;
revoke all on table public.vigilantes_estado from anon, authenticated;

-- Las funciones solo las puede ejecutar service_role (n8n).
revoke all on function public.guardar_con_archivos(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.guardar_con_archivos(jsonb, jsonb) to service_role;
revoke all on function public.salud_sistema() from public, anon, authenticated;
grant execute on function public.salud_sistema() to service_role;
revoke all on function public.resumen_proyectos() from public, anon, authenticated;
grant execute on function public.resumen_proyectos() to service_role;
revoke all on function public.reclamar_mensajes(uuid, integer) from public, anon, authenticated;
grant execute on function public.reclamar_mensajes(uuid, integer) to service_role;
revoke all on function public.liberar_turno(uuid) from public, anon, authenticated;
grant execute on function public.liberar_turno(uuid) to service_role;
revoke all on function public.anadir_contenido(uuid[], text) from public, anon, authenticated;
grant execute on function public.anadir_contenido(uuid[], text) to service_role;
revoke all on function public.contexto_avisos(text, integer) from public, anon, authenticated;
grant execute on function public.contexto_avisos(text, integer) to service_role;
revoke all on function public.marcar_borrado_drive(text[]) from public, anon, authenticated;
grant execute on function public.marcar_borrado_drive(text[]) to service_role;
revoke all on function public.olvidar_memoria(uuid) from public, anon, authenticated;
grant execute on function public.olvidar_memoria(uuid) to service_role;

commit;
