// Nodo "Preparar transcripción": convierte el audio descargado (binario "data") en el cuerpo de la petición a Gemini.
// Se lee el binario con el ayudante de n8n (sirve igual si n8n guarda los binarios en memoria o en disco). Si algo falla, el
// nodo lanza un error: con "continuar ante error" el item sigue y la llamada a Gemini falla con un mensaje honesto en
// "Leer transcripción" (nunca se manda nada raro al usuario).

/*__COMUN__*/

const salida = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const plan = $('Comprobar audio').itemMatching(i).json;
  const buffer = await this.helpers.getBinaryDataBuffer(i, 'data');
  if (!buffer || buffer.length === 0) throw new Error('Preparar transcripción: el audio descargado está vacío');
  salida.push({ json: { cuerpo: cuerpoTranscripcion({ mime: plan.mime_type, base64: buffer.toString('base64') }) }, pairedItem: { item: i } });
}
return salida;
