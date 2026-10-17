# Secretaria personal por WhatsApp

Un contacto de WhatsApp al que le mandas texto, notas de voz, fotos y documentos, y que lo entiende y lo guarda donde corresponde:
las citas en Google Calendar, los archivos en Google Drive y las tareas, listas y notas en una base de datos que puedes consultar desde
el propio chat. Te avisa de lo que se acerca, te manda un resumen cada mañana y vigila que todo siga funcionando.

Pensado para **una sola persona**: tú. Corre en un servidor pequeño propio, con n8n, Gemini y Supabase.

## Qué hace

- **Entiende y guarda** mensajes de texto, audios (los transcribe), fotos y documentos. Varios mensajes seguidos se juntan en uno.
- **Agenda:** citas en Google Calendar, sin solapes, con aviso por WhatsApp antes de empezar.
- **Alarmas** («recuérdame a las 18:30…»), con avisos 1 hora antes, 30 minutos antes y a la hora. **Respondiendo a un aviso** se aplaza
  o se mueve («10 minutos más», «muévela a las 20:00»).
- **Tareas, listas, notas y proyectos**, con consultas en lenguaje natural («qué tengo hoy», «qué alarmas tengo», «qué apunté del
  casero») y comandos (`/help`, `/today`, `/pending`, `/files`…). Los listados van con titulares cortos; «completo» enseña el detalle.
- **Cambiar de tipo** algo ya guardado («ponla como alarma», «pásalo a cita», «que sea una tarea»): lo hace el código, que mueve las
  fechas y solo confirma lo que de verdad quedó guardado. Si una alarma o cita nueva se llama como otra pendiente, pregunta si
  cambiarla o añadir otra.
- **Borrar con cuidado:** «borra todo» pregunta qué sección, y borrar en bloque enseña la lista y pide confirmación.
- **Archivos:** los organiza en carpetas de Drive a petición («guárdala en Fotos/Viajes») y te los devuelve por WhatsApp.
- **Resumen diario** a las 7:00 (con los proyectos en viñetas) y recordatorio de archivos sin clasificar.
- **Errores honestos:** si un mensaje no se puede procesar, el aviso dice cuál era (sus primeras líneas).
- **Vigilancia:** refleja lo que cambias a mano en Calendar y Drive, y te avisa (por WhatsApp y por correo) si algo se atasca o se cae.

## Cómo está hecha

```
WhatsApp ──► Meta Cloud API ──► Tailscale Funnel ──► n8n (Docker, Hetzner) ──┬──► Gemini (entiende el mensaje)
                                                                             ├──► Supabase (Postgres)
                                                                             └──► Google Calendar y Drive
```

| Pieza | Papel |
|---|---|
| **n8n** `2.41.6` (Docker) | 14 flujos: el que procesa cada mensaje y los automáticos. En un servidor Hetzner CAX11 con Ubuntu 24.04. |
| **Tailscale Funnel** | Dirección pública fija con HTTPS. Publica solo `/webhook`; el editor de n8n se abre por túnel SSH. |
| **Gemini** (`gemini-3.8-flash`) | Clasifica el mensaje y transcribe los audios. La llamada vive en un solo nodo HTTP; el modelo es una constante. |
| **Supabase** (Postgres, UE) | Mensajes, elementos, memoria, archivos y estado. RLS activado y sin acceso público. |
| **Google Calendar y Drive** | Destino de citas y archivos, sincronizados mediante «bandejas de salida» marcadas por *triggers*. |
| **Meta WhatsApp Cloud API** | Entrada y salida de mensajes, con firma verificada y un solo número permitido. |

El modelo nunca escribe SQL ni URLs: devuelve valores de listas cerradas que el código valida, y las respuestas las redacta el código.
Detalle y motivos: [`docs/arquitectura.md`](docs/arquitectura.md).

## Instalación

Todo, paso a paso y desde cero (cuentas, páginas de privacidad para Google y Meta, servidor, túnel, base de datos y pruebas):
**[`docs/manual-instalacion.md`](docs/manual-instalacion.md)**. En resumen:

1. Publica las páginas de inicio y privacidad de [`paginas/`](paginas/) en Netlify (gratis, conectado a tu copia del repositorio).
2. Prepara Google (Calendar, Drive, OAuth y Gemini), Supabase y la app de WhatsApp en Meta.
3. En el servidor: `git clone`, `bash herramientas/servidor/instalar-docker.sh`, `bash herramientas/servidor/preparar-servidor.sh`,
   rellena `.env`, activa Tailscale Funnel y `docker compose up -d`.
4. Base de datos: ejecuta [`supabase/instalar.sql`](supabase/instalar.sql) (un solo archivo) y comprueba con
   [`supabase/comprobar-instalacion.sql`](supabase/comprobar-instalacion.sql).
5. En n8n crea las cinco credenciales con sus nombres exactos y ejecuta `bash herramientas/servidor/importar-flujos.sh`: los 14 flujos
   llegan con cada nodo enlazado a su credencial. Publícalos y registra el webhook en Meta.

Coste orientativo: el servidor (unos 7 €/mes) y Gemini de prepago (pocos dólares al mes con uso personal). El resto es gratuito.

## Estructura del repositorio

```
docs/              Manual de instalación y arquitectura.
flujos/            Los 14 flujos de n8n, listos para importar (generados: no se editan a mano).
herramientas/      Código de cada nodo (flujo*/), generadores (generar-*.js) y pruebas sin red (probar-*.js).
  servidor/        Scripts del servidor: instalar Docker, preparar, importar flujos, vigilancia, copias y restauración.
  copias/          Restaurar una copia de n8n en Windows con Docker Desktop.
paginas/           Páginas de inicio y de privacidad que publica Netlify (las exigen Google y Meta).
netlify.toml       Le dice a Netlify que publique solo paginas/.
prompts/           El prompt del clasificador.
supabase/          Instalación de la base de datos, su comprobación y consultas útiles.
docker-compose.yml n8n con versión fijada, registros rotados y la clave de cifrado leída de secretos/.
.env.example       Plantilla de variables de entorno (secretos de WhatsApp e identificadores).
```

## Desarrollo

Solo hace falta Node.js (18 o superior); las pruebas no usan red ni gastan nada.

```
npm test          # todas las baterías de pruebas
npm run generar   # regenera los flujos de flujos/ a partir de herramientas/ y prompts/
```

El código de cada nodo se cambia en `herramientas/flujo*/` y se regenera; un cambio hecho a mano en un JSON de `flujos/` se pierde.
Después, en el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y volver a publicar los flujos.

## Seguridad

- Ningún secreto en el repositorio: el `.env` y `secretos/` están en `.gitignore`; las claves de las APIs solo viven cifradas en n8n.
- La clave de cifrado de n8n se lee de un archivo de solo lectura, no del entorno.
- Solo el webhook es público y está protegido por la firma de Meta y por el número permitido; el servidor solo acepta SSH con clave.
- Las copias de seguridad contienen credenciales cifradas y datos personales: se guardan fuera del repositorio.

> **Nunca ejecutes `docker compose down -v`:** borra el volumen con todos los flujos y credenciales de n8n. La carpeta del proyecto
> debe llamarse `Secretaria` (el volumen se llama `secretaria_n8n_data` por ella).

## Licencia

[MIT](LICENSE): puedes usarlo, copiarlo y modificarlo libremente, manteniendo el aviso de copyright. Se ofrece tal cual, sin garantías:
cada persona que lo monte es responsable de sus claves, sus datos y el coste de los servicios que use.
