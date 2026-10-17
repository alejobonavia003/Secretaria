// Nodo "Revisar envíos de archivos": sale del bucle "Recorrer envíos" cuando ya se han mandado todos (salida "done", que trae la
// respuesta de cada envío). Si alguno falló (un 4xx de Meta, por ejemplo) hace fallar la ejecución para que quede en rojo y el flujo
// "Aviso de fallos" pueda avisar: "Enviar archivo" no corta el flujo ante un error, así que sin esto pasaría desapercibido.
// Si todo fue bien no devuelve nada.

const resumen = (e) =>
  String(typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e ?? '')))
    .replace(/\s+/g, ' ')
    .slice(0, 200);

const respuestas = $input.all().map((i) => i.json);
const fallidas = respuestas.filter((r) => r && r.error);
if (fallidas.length > 0) {
  throw new Error(`Secretaria · WhatsApp: ${fallidas.length} de ${respuestas.length} mensajes de archivos no se enviaron (${resumen(fallidas[0].error)})`);
}
return [];
