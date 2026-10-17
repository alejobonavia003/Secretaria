# Prompt del clasificador

[`clasificador.md`](clasificador.md) es el prompt que recibe Gemini en el nodo `Construir petición` del flujo «Procesar mensaje».
Se inserta en el flujo al generarlo (`npm run generar`): no se edita en el JSON de `flujos/`.

- Pide **solo un JSON**: la intención (`guardar`, `consultar`, `corregir`, `completar`, `cancelar`, `aclarar`, `recordar`, `archivar`,
  `ver_archivos`, `crear_carpeta`…) y los elementos, con valores de listas cerradas. El código (`herramientas/flujo/planificar.js`)
  valida cada campo y rechaza lo que no encaje.
- Las variables entre llaves (`{{memoria}}`, `{{ultimos_items}}`, `{{proyectos}}`, `{{fecha_actual}}`…) las rellena el código en cada mensaje.
- Las fechas van en ISO 8601 con el desfase de `Europe/Madrid`; el código lo comprueba.
- Para cambiar el tipo de algo guardado, el modelo solo devuelve `correccion.convertir_a` (`alarma`, `cita` o `tarea`) y, si el usuario
  la dio, `correccion.cuando`: el código mueve las fechas. El código depende de esos campos, así que un prompt que no los produzca
  deja de convertir.
- Los títulos se piden como titulares (2–6 palabras, máximo 40 caracteres): son lo único que sale en los listados.
- Lo que no necesita interpretación (comandos, frases fijas, aplazamientos simples al responder a un aviso) no llega al modelo.

Si lo cambias, prueba con mensajes reales variados antes de dejarlo: un ajuste pensado para un caso concreto suele empeorar otros.
