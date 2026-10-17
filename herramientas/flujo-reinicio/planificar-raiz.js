// Nodo "Planificar raíz": lee lo que cuelga de la carpeta raíz de Drive y decide dos cosas:
//   - qué hijos de la raíz van a la papelera (todo lo que no sea una de las carpetas que se conservan);
//   - qué carpetas conservadas hay que VACIAR: una salida por cada una, con la URL para listar su contenido.
// Nunca borra nada: solo prepara. Las carpetas conservadas se identifican por nombre (sin distinguir mayúsculas ni tildes) y por ser carpetas.

const config = $('Configuración').first().json.config;
const respuesta = $input.first().json;
const hijos = Array.isArray(respuesta?.files) ? respuesta.files : [];

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const CARPETA = 'application/vnd.google-apps.folder';
const conservar = new Set(config.conservar.map(sinAcentos));
const esId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{10,}$/.test(v);

const validos = hijos.filter((f) => f && esId(f.id));
const conservadas = validos.filter((f) => f.mimeType === CARPETA && conservar.has(sinAcentos(f.name)));
const paraPapelera = validos.filter((f) => !conservadas.includes(f));

const urlHijos = (idCarpeta) =>
  'https://www.googleapis.com/drive/v3/files?pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=' +
  encodeURIComponent('nextPageToken,files(id,name,mimeType)') +
  '&q=' +
  encodeURIComponent(`'${idCarpeta}' in parents and trashed=false`);

const comunes = { raiz_incompleta: Boolean(respuesta?.nextPageToken), conservadas_encontradas: conservadas.map((f) => f.name) };

// Una salida por carpeta conservada. Sin ninguna, una salida inocua (listar de nuevo la raíz) para que el flujo siga.
if (conservadas.length === 0) {
  return [{ json: { ...comunes, para_papelera: paraPapelera.map((f) => ({ id: f.id, nombre: f.name })), inocua: true, url: urlHijos(config.carpeta_raiz_id), carpeta: null } }];
}
return conservadas.map((f, i) => ({
  json: {
    ...comunes,
    // La lista de la raíz viaja solo en la primera salida (para no repetirla)
    para_papelera: i === 0 ? paraPapelera.map((x) => ({ id: x.id, nombre: x.name })) : [],
    inocua: false,
    url: urlHijos(f.id),
    carpeta: f.name,
  },
}));
