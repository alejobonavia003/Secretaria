-- Revisar los mensajes que se quedaron SIN PROCESAR y sin motivo anotado (los que cuenta el «Latido»: «N mensajes tuyos no se procesaron»).
-- Pasa, por ejemplo, si el flujo principal no estaba publicado («Workflow is not active») o una ejecución murió a medias.
-- No borra nada ni los procesa: les anota el motivo «Revisado a mano…» para que el Latido deje de contarlos. Si alguno era importante,
-- vuelve a mandárselo a la secretaria (el original queda en texto_original).
-- Solo toca los de las últimas 24 horas que no están en la cola esperando turno. Ejecútalo entero; termina con la tabla de los revisados.
drop table if exists pg_temp.revisados;
create temp table revisados as
with marcados as (
  update public.mensajes
     set error = 'Revisado a mano: no se procesó; si hacía falta, se volvió a mandar'
   where not procesado and error is null and not en_cola
     and created_at between now() - interval '24 hours' and now() - interval '3 minutes'
  returning created_at, tipo_entrada, left(texto_original, 70) as texto
)
select * from marcados;
select * from revisados order by created_at;
