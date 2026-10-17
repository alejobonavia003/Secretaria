// Nodo "Decidir envío de archivo": con los metadatos reales de Drive decide si el archivo se manda de verdad o si se manda su enlace.
// Un item de entrada, uno de salida SIEMPRE (dentro del bucle "Recorrer envíos" una iteración sin salida cortaría el bucle).
//   mandar  { mandar: true, id, nombre, mime, categoria }                (sigue a "Descargar de Drive")
//   enlace  { mandar: false, cuerpo: <mensaje de texto con el enlace> }   (va directo a "Enviar archivo")

/*__COMUN__*/

// --- Pegamento con n8n ---
const config = $('Configuración').first().json.config;
const para = soloDigitos($env.WHATSAPP_NUMERO_PERMITIDO);
if (!para) throw new Error('Decidir envío de archivo: falta WHATSAPP_NUMERO_PERMITIDO en el entorno de n8n');

return $input.all().map((item, i) => {
  // La respuesta de Drive ha sustituido al item: el archivo que se pidió se recupera del bucle por posición
  const archivo = $('Recorrer envíos').itemMatching(i).json;
  const plan = planificarEnvioArchivo({ archivo, metadatos: item.json, limiteMb: config.limite_adjunto_mb });
  const json =
    plan.accion === 'mandar'
      ? { mandar: true, id: plan.id, nombre: plan.nombre, mime: plan.mime, categoria: plan.categoria }
      : plan.accion === 'enlace'
        ? { mandar: false, cuerpo: cuerpoEnlaceArchivo({ para, id: plan.id, nombre: plan.nombre, razon: plan.razon }) }
        : { mandar: false, cuerpo: cuerpoAvisoArchivo({ para, nombre: archivo.nombre }) };
  return { json, pairedItem: { item: i } };
});
