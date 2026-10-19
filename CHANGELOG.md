# Cambios

Formato: cada versión dice qué cambia para quien la usa y qué hay que hacer para actualizar una instalación existente.

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
