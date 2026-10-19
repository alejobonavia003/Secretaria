// Nodo "Revisar envíos de archivos": sale del bucle "Recorrer envíos" cuando ya se han mandado todos (salida "done", que trae la
// respuesta de cada envío) y resume cómo fue: { archivos_total, archivos_fallidos, archivos_error }. Ya no lanza el error aquí: después
// hay que anotar lo contestado y soltar el turno (si no, lo siguiente esperaría 10 minutos); lo hace "Comprobar envío" al final, y la
// ejecución queda en rojo igual que antes para que el flujo "Aviso de fallos" pueda avisar. Devuelve SIEMPRE un item.

const resumen = (e) =>
  String(typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e ?? '')))
    .replace(/\s+/g, ' ')
    .slice(0, 200);

const respuestas = $input.all().map((i) => i.json);
const fallidas = respuestas.filter((r) => r && r.error);
return [{ json: { archivos_total: respuestas.length, archivos_fallidos: fallidas.length, archivos_error: fallidas.length > 0 ? resumen(fallidas[0].error) : null } }];
