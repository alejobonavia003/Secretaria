-- Solo lee: los 8 últimos mensajes, con si se procesaron y el error si lo hubo (el flujo principal guarda ahí el motivo cuando contesta "No he podido procesar ese mensaje").
select created_at, tipo_entrada, left(texto_original, 70) as texto, procesado, left(error, 600) as error from public.mensajes order by created_at desc limit 8;
