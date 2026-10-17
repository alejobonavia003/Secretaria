// Nodo "Preparar registro del aviso": tras enviar el aviso, anota en avisos_enviados el id del mensaje que devolvió Meta
// y qué elementos iban en él. Así, si respondes a este aviso («10 minutos más», «muévela a las 12»), el flujo principal sabe de qué
// cita hablas.
// Si Meta no devolvió un id válido no se anota nada (el aviso ya se mandó; solo se pierde poder responderle).

const config = $('Configuración').first().json.config;
const VALIDO = /^[A-Za-z0-9._=+\/-]{1,300}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const wamid = $input.first()?.json?.messages?.[0]?.id;
if (typeof wamid !== 'string' || !VALIDO.test(wamid)) return [];

const redactado = $('Redactar aviso').first().json;
const ids = [...new Set((redactado.ids ?? []).map((x) => (typeof x === 'string' ? x : x?.id)).filter((i) => typeof i === 'string' && ID.test(i)))];
if (ids.length === 0) return [];

return [
  {
    json: {
      url: `${config.supabase_url}/rest/v1/avisos_enviados?on_conflict=wa_message_id,item_id`,
      cuerpo: ids.map((id) => ({ wa_message_id: wamid, item_id: id, tipo: 'cita' })),
    },
  },
];
