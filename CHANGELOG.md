# Cambios

Formato: cada versión dice qué cambia para quien la usa y qué hay que hacer para actualizar una instalación existente.

## 1.2.0 · 2026-10-19

### Novedades

- **Horario fijo semanal** («trabajo los viernes de 16 a 20»): si apuntas una cita que cae dentro, pregunta antes de apuntarla.
  `/horario` lo enseña y `/horario quitar N` quita un bloque. Si no das horas exactas, pregunta de qué hora a qué hora.
- **Todo se contesta en el orden de llegada**, también fotos, documentos y audios: «texto, foto, texto» recibe tres respuestas en ese
  orden. Si mandas varios mensajes seguidos, cada respuesta cita el mensaje al que contesta.
- **La compra:** lo que sea comprar va a la lista de la compra aunque digas un día («mañana compra pan»), y pregunta si te avisa ese
  día para ir a comprar («a las 18» crea la alarma; «no», nada).
- **Listas sin repetidos:** lo que ya está pendiente en la misma lista no se vuelve a apuntar; la respuesta dice qué ya estaba.

### Cambios

- «Borra la cita», «quita la alarma de la ropa»: si solo hay una que encaje, la quita sin preguntar.
- Un «tarea», «cita» o «alarma» suelto que llega justo después de apuntar algo se resuelve sin el modelo (lo deja como está o lo
  convierte).
- El «🎙️ Entendí: …» de un audio sale justo antes de su respuesta.
- Olvidar un dato de la memoria con palabras pide un «sí» o un «no» que se entiende sin el modelo.
- **Más rápido:** las lecturas de Supabase del flujo principal se hacen una sola vez por mensaje (antes podían repetirse por cada
  dato de la memoria).
- Nueva consulta `supabase/consultas/ver-version.sql`: dice qué versión de la base de datos tienes instalada.

### Para actualizar desde la 1.1

1. Haz una copia de n8n (parte 15 del manual).
2. En el SQL Editor de Supabase, ejecuta [`supabase/actualizar-1.2.sql`](supabase/actualizar-1.2.sql) **una vez** y comprueba con
   `supabase/comprobar-instalacion.sql` (10 filas con `ok = true`). Crea dos tablas (`horario_fijo` y `llegadas`) y cambia la
   función de la cola de mensajes; no toca tus datos.
3. En el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los flujos (parte 11.5 del manual).
   La base de datos va **antes** que los flujos: **sin el paso 2, la secretaria deja de contestar** (el flujo de WhatsApp llama a la
   función de la cola con un parámetro que la 1.1 no tiene).

Si vienes de la 1.0, ejecuta antes `supabase/actualizar-1.1.sql` (y después este). `supabase/consultas/ver-version.sql` te dice cuál
tienes.

## 1.1.0 · 2026-10-19

### Novedades

- **Borrar carpetas y archivos de Drive por WhatsApp** («borra la carpeta Fotos/Viajes», «vacía la carpeta Facturas», «borra la foto
  del DNI»). Enseña la lista de lo que se borraría y solo lo manda a la papelera de Drive (recuperable unos 30 días) si contestas que
  sí. Antes de mandarlo vuelve a comprobar cada carpeta y archivo; `Entrada` y `Notas` no se borran enteras.
- **Memoria de datos duraderos:** recuerda lo que le cuentas que dura («trabajo los viernes por la mañana», «Emma es mi hermana») y
  cómo quieres que te llame («llámame Ana»). `/memory` enseña lo que recuerda (hasta 50 datos) y `/forget N` olvida uno.
- **Charla breve:** contesta a saludos y comentarios con naturalidad, sin guardar nada.

### Cambios

- **No adivina:** si la respuesta del modelo no encaja o su confianza es baja, pregunta o dice «no te he entendido» en vez de guardar
  algo mal.
- **Aviso de fallos más fiable:** solo llega cuando falla de verdad un flujo, Supabase o Google, no cuando no entiende un mensaje.
- **Prompt:** nuevas reglas para la charla, los datos duraderos, el nombre del usuario, borrar en Drive y no prometer lo que el sistema
  no hace.

### Para actualizar desde la 1.0

1. Haz una copia de n8n (parte 15 del manual).
2. En el SQL Editor de Supabase, ejecuta [`supabase/actualizar-1.1.sql`](supabase/actualizar-1.1.sql) **una vez** y comprueba con
   `supabase/comprobar-instalacion.sql` (10 filas con `ok = true`). Añade dos funciones; no toca tablas ni datos.
3. En el servidor: `git pull`, `bash herramientas/servidor/importar-flujos.sh` y vuelve a publicar los flujos (parte 11.5 del manual).
   La base de datos va **antes** que los flujos: sin el paso 2, borrar en Drive y `/forget` fallan.

## 1.0.0 · 2026-10-17

Primera versión publicada: clasificación de texto, audios, fotos y documentos; agenda en Google Calendar sin solapes; alarmas con
avisos; tareas, listas, notas y proyectos; archivos en Google Drive; resumen diario; vigilancia de Calendar y Drive; aviso de fallos
y latido; manual de instalación completo.
