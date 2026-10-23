-- Solo lee (no cambia nada): cuánto tarda la secretaria en contestar, medido desde que envías el mensaje hasta que se manda la respuesta.
-- Requiere la base de datos de la versión 1.2 o posterior (tabla llegadas). Cubre los últimos 7 días. Ejecútalo entero; termina con una tabla.
--   - Mide TODO el camino: el aviso de Meta, la cola y el turno, Gemini (si hace falta) y el envío. Los mensajes que se resuelven por código
--     (comandos, «dame todo», «dame la jerarquía de carpetas»…) salen en segundos; los que pasan por Gemini, más.
--   - Si se contestan varios mensajes juntos, todos comparten la hora de respuesta. Los que tardaron más de 1 hora (nunca se contestaron
--     a tiempo) o salen con la hora al revés (reloj de Meta) no cuentan.
--   - No enseña el texto de ningún mensaje: solo su tipo, su hora, su longitud y los segundos. Puedes pegarlo tal cual.
-- Cómo leerlo: «mediana» es el tiempo típico; «p90», el de 9 de cada 10 mensajes; «maximo», el peor.
with base as (
  select l.wa_message_id,
         l.tipo,
         l.enviado_at,
         round(extract(epoch from (l.contestado_at - l.enviado_at))::numeric, 1) as seg,
         (l.enviado_at at time zone 'Europe/Madrid')::date as dia
    from public.llegadas l
   where l.contestado_at is not null
     and l.enviado_at > now() - interval '7 days'
     and l.contestado_at >= l.enviado_at
     and l.contestado_at - l.enviado_at < interval '1 hour'
),
resumen as (
  select '1 por tipo' as seccion, b.tipo as clave, count(*)::int as mensajes,
         round((percentile_cont(0.5) within group (order by b.seg))::numeric, 1) as mediana_s,
         round((percentile_cont(0.9) within group (order by b.seg))::numeric, 1) as p90_s,
         max(b.seg) as maximo_s,
         b.tipo as orden
    from base b group by b.tipo
  union all
  select '2 por día', to_char(b.dia, 'DD/MM'), count(*)::int,
         round((percentile_cont(0.5) within group (order by b.seg))::numeric, 1),
         round((percentile_cont(0.9) within group (order by b.seg))::numeric, 1),
         max(b.seg),
         to_char(b.dia, 'YYYY-MM-DD')
    from base b group by b.dia
  union all
  select '3 reparto', t.nombre, count(b.wa_message_id)::int, null, null, null, t.orden
    from (values ('a) menos de 5 s', 0, 5, 'a'), ('b) de 5 a 15 s', 5, 15, 'b'), ('c) de 15 a 30 s', 15, 30, 'c'), ('d) de 30 a 60 s', 30, 60, 'd'), ('e) más de 1 minuto', 60, 100000, 'e')) as t(nombre, desde, hasta, orden)
    left join base b on b.seg >= t.desde and b.seg < t.hasta
   group by t.nombre, t.orden
  union all
  select '4 los 10 más lentos', to_char(l.enviado_at at time zone 'Europe/Madrid', 'DD/MM HH24:MI') || ' ' || l.tipo || ' (' || coalesce(length(m.texto_original), 0)::text || ' car.)',
         1, l.seg, null, null, lpad((100000 - l.seg)::text, 9, '0')
    from (select * from base order by seg desc limit 10) l
    left join public.mensajes m on m.wa_message_id = l.wa_message_id
)
select seccion, clave, mensajes, mediana_s, p90_s, maximo_s
  from resumen
 order by seccion, orden;
