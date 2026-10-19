# Arquitectura y decisiones de diseño

Cómo está hecha la secretaria y por qué. Para instalarla, el [manual](manual-instalacion.md).

## Principios

1. **El modelo interpreta; el código decide.** Gemini solo devuelve un JSON con una intención y valores de listas cerradas (tipo,
   fechas, carpeta…). Nunca aporta SQL, URLs ni identificadores: ve los elementos como referencias cortas (`i1`, `a2`…) que el código
   traduce a ids reales, y una referencia que no le enseñó es un error.
2. **Las respuestas las redacta el código**, no el modelo: dicen exactamente lo que se ha guardado (con las horas calculadas), y si algo
   falla el usuario recibe un mensaje honesto, nunca un éxito falso.
3. **Las reglas estrictas viven en código**: solapes de la agenda, qué es una alarma y qué una cita, validación de rutas de carpeta,
   confirmación antes de quitar en bloque.
4. **Lo que no necesita al modelo no lo usa**: los comandos (`/help`, `/today`…), las frases fijas («qué tengo hoy», «cómo te llamas»,
   «qué proyectos / alarmas / citas / tareas / pensamientos / listas tengo») y los aplazamientos simples («10 minutos más» respondiendo
   a un aviso) se contestan sin llamar a Gemini: más rápido y sin coste.
5. **Nada se borra a ciegas**: cancelar archiva (recuperable); en Drive solo se borra lo que el usuario confirma tras ver la lista, y
   siempre a la papelera (recuperable unos 30 días); los eventos se borran de Calendar solo si su elemento está archivado.
6. **No adivinar**: si la respuesta del modelo no encaja o su confianza es baja (< 0,7), el código pregunta o contesta «no te he
   entendido» y no hace nada. Eso no es un fallo: el aviso de fallos queda para cuando falla de verdad el flujo, Supabase o Google.

## Flujos de n8n

Los JSON de [`flujos/`](../flujos/) son **generados** (`npm run generar`): el código de cada nodo vive en `herramientas/flujo*/` y
el prompt en [`prompts/clasificador.md`](../prompts/clasificador.md). Cada flujo lleva un id fijo, sus credenciales referenciadas por
nombre y «Aviso de fallos» como *Error workflow* (`herramientas/comun/importacion.js`).

| Flujo | Disparo | Qué hace |
|---|---|---|
| WhatsApp | Webhook de Meta | Verifica la firma `X-Hub-Signature-256` y el número permitido, descarta duplicados, transcribe audios, sube archivos a Drive, registra el orden de llegada de cada mensaje, pone los textos y audios en la cola y contesta todo en ese orden (citando el mensaje si llegaron varios). |
| Procesar mensaje | Llamado por WhatsApp | Lee contexto (memoria, pendientes, pregunta abierta, archivos, proyectos, avisos, horario fijo), llama al modelo si hace falta, valida, escribe en Supabase y redacta la respuesta. |
| Sincronizar Calendar | Cada minuto | Lleva a Google Calendar los eventos marcados como pendientes de sincronizar (crear, mover, borrar). |
| Sincronizar Drive | Cada minuto | Mueve, renombra y crea carpetas en Drive según lo marcado en la base de datos. |
| Vigilar Calendar / Vigilar Drive | Cada 5 minutos | Detectan lo que se cambia a mano en Calendar o Drive, lo reflejan en la base de datos y avisan. |
| Recordatorios | Cada minuto | Avisos de las alarmas: 1 hora antes, 30 minutos antes y a la hora. |
| Avisos de eventos | Cada minuto | Aviso por WhatsApp de una cita que empieza pronto. Guarda qué iba en cada aviso para poder responderle («retrásala media hora»). |
| Resumen diario | 7:00 | Un mensaje con lo de hoy, lo atrasado y lo pendiente (proyectos en viñetas, una por cosa). |
| Recordatorio de archivos | 19:00 | Archivos que llevan más de un día sin clasificar. |
| Limpieza de eventos | 3:00 | Archiva los eventos que acabaron hace más de 7 días (y así salen de Calendar). |
| Latido | Cada 5 minutos | Detecta atascos (eventos sin sincronizar, mensajes sin procesar, reloj desfasado…) y avisa al monitor externo y por WhatsApp. |
| Aviso de fallos | *Error workflow* | Un WhatsApp corto cuando otro flujo falla de verdad (no cuando no entiende un mensaje), como mucho uno por flujo cada hora y diez al día. |
| Reiniciar todo | Manual | Vacía Calendar y Drive (a la papelera), con ensayo previo. No se publica. |

## Base de datos (Supabase / Postgres)

Esquema completo en [`supabase/instalar.sql`](../supabase/instalar.sql). RLS activado en todas las tablas y sin permisos para `anon`
ni `authenticated`: solo la clave secreta (`service_role`) que usa n8n puede leer y escribir.

| Tabla | Contenido |
|---|---|
| `mensajes` | Todo lo que llega, tal cual, con su estado (procesado, error, en cola) y la pregunta abierta si la hay. |
| `items` | Lo clasificado: eventos, tareas, listas y notas, con su proyecto si lo tienen. |
| `archivos` | Archivos recibidos: id de Drive, carpeta pedida, a qué elemento pertenecen. |
| `memoria` | Términos que el usuario enseña («BBVA es mi banco»), datos duraderos que cuenta («Emma es mi hermana», «vivo en Granada»), cómo quiere que se le llame y el nombre de la secretaria. Hasta 50; `/memory` la enseña y `/forget` borra un dato. |
| `proyectos`, `carpetas_pedidas` | Proyectos (activo/cerrado) y carpetas que se piden crear. |
| `drive_arbol`, `registro_drive`, `vigilantes_estado`, `registro_calendar` | Estado y registro de los vigilantes. |
| `avisos_enviados` | Qué alarmas y citas iban en cada aviso enviado (para entender las respuestas a un aviso). |
| `turno` | Fila única: quién está procesando la cola de mensajes. |
| `llegadas` | Orden de llegada de todos los mensajes (de cualquier tipo), para contestarlos en ese orden. Se vacía sola (2 días). |
| `horario_fijo` | Horario semanal del usuario: un bloque por día con su título y sus horas. |

**Bandejas de salida:** los cambios hacia Google no se hacen en línea. Un *trigger* marca el elemento (`calendar_pendiente`,
`drive_pendiente`) y un flujo aparte lo sincroniza cada minuto. Así el mensaje se guarda aunque Google falle, y la sincronización se
puede parar sin tocar el flujo principal. Las escrituras de vuelta comprueban `updated_at` para no pisar un cambio hecho mientras tanto,
y el id del evento de Calendar se deriva del id del elemento (sin duplicados).

**Cola de mensajes:** varios mensajes seguidos se procesan juntos y nunca dos a la vez. Cada texto entra en cola; tras una espera breve,
`reclamar_mensajes()` decide si esta ejecución procesa (toma el turno y se lleva todos los encolados), espera (otra tiene el turno) o no
hace nada (llegó otro después, que los juntará). El turno caduca solo si una ejecución muere.

**Orden de llegada:** cada mensaje, sea del tipo que sea, se registra al llegar con la hora que da Meta (`registrar_llegadas()`).
La cola no junta mensajes por encima de uno anterior sin contestar (una foto que aún se sube, un audio que aún se transcribe), y antes
de contestar una foto, un documento o un aviso, `turno_respuesta()` dice si queda algo anterior pendiente: si es así, espera. Así
«texto, foto, texto» se contesta en tres pasos y en ese orden. Si el usuario ha mandado varios mensajes, cada respuesta cita el
suyo. Un mensaje que no llegó a guardarse deja de hacer esperar al cabo de 1 minuto (texto) o 5 (audio).

## Reglas de comportamiento

- **Alarma o cita:** lo que empieza antes de las 02:00 del día siguiente es una **alarma** (tarea con `recordar_en`, avisos por
  WhatsApp, no va a Calendar); lo posterior es una **cita** (evento en Calendar con aviso 30 minutos antes).
  Si el mensaje dice «cita» o «calendario», se respeta: es cita aunque empiece enseguida.
- **Cambiar de tipo:** el modelo solo dice a qué tipo (`correccion.convertir_a`) y, si el usuario lo dio, cuándo (`correccion.cuando`).
  El código mueve las fechas (alarma = `recordar_en` sin plazo; cita = inicio y una hora; tarea = el día pasa a plazo), reabre una
  alarma ya sonada, pasa por los controles de solape y de hora pasada, y pregunta la hora si hace falta. La confirmación se redacta
  con la fila que devolvió la base de datos: si no quedó como se pidió, lo dice. Una cita que deja de serlo se borra de Calendar.
- **Ambigüedad de tipo:** «mañana coger la cartera» no dice si es alarma, cita o tarea: se pregunta, salvo que se deduzca («tengo que»,
  un plazo, «recuérdame», una reunión…).
- **Nombres repetidos:** una alarma o cita nueva con un nombre igual o muy parecido a otra pendiente pregunta «¿La cambio o añado otra?»
  («¿cuáles hay?» enseña las parecidas). Las tareas no preguntan.
- **Agenda:** un evento no puede solaparse con otro (se pregunta otra hora); en un día con cosas, se enseñan y se pide confirmación.
  Sin duración, se asume una hora y se dice en la respuesta.
- **Horario fijo:** el modelo convierte «trabajo los viernes de 16 a 20» en bloques (uno por día); si no da horas exactas, pregunta.
  Una cita que cae dentro de un bloque se pregunta antes de apuntarla («¿La apunto igualmente?»), y el «sí» vale para ese bloque ese
  día. Las alarmas no se comprueban. `/horario` y `/horario quitar N` se resuelven sin el modelo.
- **La compra:** una tarea «Comprar pan y huevos» pasa a la lista de la compra por código, un elemento por cosa. Si el mensaje dice
  un día, pregunta si avisa ese día para ir a comprar; la respuesta («a las 18», «no») se entiende sin el modelo y crea una alarma
  «Ir a comprar».
- **Listas sin repetidos:** un elemento que ya está pendiente en la misma lista no se vuelve a guardar (sin distinguir mayúsculas,
  tildes, artículos ni plural simple); la respuesta dice cuáles ya estaban.
- **Listados:** solo el título (el prompt pide titulares de 2 a 6 palabras); si hay más contexto se marca con « …» y se ve con
  «completo». Nunca se repite el mensaje original del usuario.
- **Errores:** si un mensaje falla, el aviso cita hasta 3 líneas suyas (50 caracteres cada una) para que se sepa cuál fue.
- **Preguntas:** si falta un dato (el motivo de una cita, la hora de un evento), la secretaria pregunta. La pregunta y el hilo se
  guardan 30 minutos: la respuesta siguiente se entiende en ese contexto. Puede haber **hasta tres preguntas abiertas** a la vez (el
  usuario escribe antes de que le llegue la respuesta): el código decide a cuál contesta cada mensaje por su contenido (sí/no, una hora,
  alarma/cita/tarea, cambiar/añadir) y una orden nueva («borra…», «dame…», «qué…») no contesta a ninguna. Un «sí» o un «no» sueltos
  sin pregunta abierta no llaman al modelo.
- **Mensajes de golpe:** más de 8 textos o audios seguidos no se procesan (se avisa para que se manden en tandas) y de una misma
  notificación se guardan como mucho 10 archivos. Los límites son `MAX_MENSAJES_DE_GOLPE` y `MAX_ADJUNTOS_DE_GOLPE`, al principio de
  `herramientas/flujo-whatsapp/comun.js`.
- **Archivos:** todo llega a `Secretaria/Entrada/` (los enlaces de Meta caducan en minutos) y se clasifica a mano, respondiendo a la foto
  o con órdenes («guárdala en Fotos/Viajes», «las tres últimas son facturas de la luz»).
- **Proyectos y carpetas:** no hay listas fijas. Un proyecto se crea al usarlo (si se parece a uno que ya existe, se pregunta antes);
  las carpetas de Drive se crean al pedirlas. Los archivos de un elemento van a `Notas/` salvo que se pida otra carpeta.
- **Quitar una cosa:** «borra la cita», «quita la alarma de la ropa»: si de ese tipo (y con esas palabras) hay exactamente una, se
  quita por código, sin el modelo; si hay varias, decide el modelo y pregunta cuál.
- **Borrar:** «borra todo» nunca borra todo: se reconoce por código y pregunta qué sección (alarmas, tareas, citas, pensamientos,
  cada lista y cada proyecto, con cuántos elementos tiene cada una). Borrar una sección entera o más de un elemento a la vez se
  confirma **siempre**, enseñando la lista de lo que se quitaría; con esa pregunta abierta, el nombre de una sección es esa sección
  (no su listado) y un «sí» corto quita exactamente lo que se enseñó. Quitar una sola cosa por su nombre no pregunta; marcar como
  hecho pregunta a partir de cuatro.
- **Memoria:** solo se guarda lo que el usuario enseña o cuenta como estable sobre sí mismo (horarios fijos, quién es quién); nunca lo
  que el modelo deduce, ni una tarea o una cita de un día concreto. Un dato sobre lo mismo sustituye al anterior. `/memory` enseña la
  lista numerada y `/forget N` borra ese dato; «olvida lo del trabajo» enseña los que encajan y pregunta antes. El nombre de la
  secretaria no se olvida, se cambia.
- **Charla:** a un saludo o un comentario contesta el modelo en una o dos frases, pero el código descarta cualquier respuesta que diga
  haber guardado o cambiado algo: con charla no se escribe nada.
- **Borrar en Drive:** el modelo solo dice qué carpeta o qué archivos; el código busca la carpeta en el árbol (si el nombre está en dos
  sitios, pregunta cuál), enseña todo lo que se borraría y guarda en la pregunta los ids exactos. Con el «sí», vuelve a comprobar cada id
  contra el árbol actual (que cuelgue de `Secretaria/` y no sea `Entrada` ni `Notas`, que no se borran enteras), lo manda a la papelera
  y lo anota con `marcar_borrado_drive()` para que «Vigilar Drive» no lo avise como un borrado a mano.

## Seguridad

- Los secretos no están en el repositorio: el `.env` (secretos de WhatsApp e identificadores) y la clave de cifrado de n8n viven solo en
  el servidor; las claves de las APIs, solo en las credenciales cifradas de n8n.
- La clave de cifrado de n8n se lee de un archivo de solo lectura (`N8N_ENCRYPTION_KEY_FILE`), no del entorno, porque los nodos Code
  pueden leer las variables de entorno (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, necesario para la firma de Meta).
- Solo `/webhook` es público (Tailscale Funnel); el editor de n8n escucha en `127.0.0.1` y se abre por túnel SSH. El firewall del
  servidor solo admite SSH, y SSH solo con clave.
- El webhook comprueba la firma HMAC de Meta y el número del remitente. El token de WhatsApp solo se envía a dominios de Meta.
- Gemini en plan de pago: Google no usa lo enviado para mejorar sus productos.

## Límites conocidos

- **Ventana de 24 horas de Meta:** sin plantillas aprobadas, solo se puede escribir a quien te escribió en las últimas 24 horas. Si un
  día no escribes a la secretaria, el resumen, los recordatorios y los avisos de ese día esperan (el monitor externo sí avisa por correo
  de las caídas).
- **El modelo puede clasificar mal:** el código valida la forma, no la intención. La respuesta siempre dice qué se ha guardado, para
  corregirlo («no, era el jueves»).
- **A qué pregunta contesta un mensaje:** se decide por palabras; una respuesta rara con varias preguntas abiertas puede asignarse a
  otra. El límite de archivos cuenta por notificación de Meta, no por ráfaga.
- **Vigilantes:** hasta 5 minutos de retraso; Drive se vigila hasta 4 niveles y Calendar no ve eventos periódicos ni de todo el día.
- **Charla y datos duraderos:** los decide el modelo; puede guardar como dato algo que no lo era, o contestar como charla a algo que
  pedía otra cosa. `/memory` permite revisarlo y `/forget`, corregirlo.
- **Saldo de Gemini:** no hay API para consultarlo; sin saldo, Gemini devuelve 402 y llega el aviso de fallos.
- **Copia de Supabase:** no es automática; los datos que solo viven ahí (mensajes, tareas, notas, memoria) no tienen copia salvo que la
  hagas tú (parte 15 del manual). Archivos y citas están en Drive y Calendar.
