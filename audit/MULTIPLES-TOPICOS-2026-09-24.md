# Ampliación: varios tópicos activos simultáneamente

## Rectificación de alcance

La medición inicial de RAM se hizo con el puente desconectado. **No permite descartar problemas que aparecen únicamente al conectar varias sesiones.** El análisis debe distinguir tópicos existentes de sesiones Pi conectadas y procesando mensajes.

## Prueba realizada

Comando: `node --max-old-space-size=192 audit/multi-topic-probe.mjs`.

- Dispatcher de producción en un subprocess Node, limitado a 128 MiB de heap V8 (no es un límite de RSS).
- Ocho clientes del verdadero forum-client.mjs, ocho tópicos distintos.
- API Telegram simulada por HTTP exclusivamente en localhost, HOME temporal y token ficticio.
- 400 mensajes de aproximadamente 4 KB, 50 por tópico, distribuidos alternadamente. Consumidores bloqueados deliberadamente mediante una promesa, sin grandes archivos ni agentes/modelos reales.
- Límite temporal externo de 25 segundos. Al finalizar se cerraron clientes/servidor y se eliminó HOME temporal.

Resultados:

| Condición | RSS dispatcher | RSS del harness con los 8 clientes y API simulada |
|---|---:|---:|
| 8 conectados, sin tráfico | 86.796 KiB (~84,8 MiB) | 62 MiB |
| 400 mensajes confirmados, consumidores bloqueados | 88.380 KiB (~86,3 MiB) | 76 MiB |

Los puntos de RSS son muestras, no picos máximos. El crecimiento del harness incluye la API simulada, serialización, conexiones y generación de tráfico; **no es una medición aislada de una fuga del cliente**. Ocho clientes en un proceso de prueba no equivalen a ocho procesos Pi completos. La prueba es funcional, no una validación de estabilidad de días.

Afirmaciones verificadas:

1. Un único `getUpdates` en vuelo, compartido por los ocho tópicos.
2. El cursor llegó a 401 aunque ninguno de los 400 handlers había completado.
3. Había ocho handlers iniciados/bloqueados y 392 esperando detrás de ellos.
4. Al liberar los consumidores se entregaron exactamente 50 mensajes a cada tópico, sin mezcla ni duplicados en esta ejecución.
5. Tras cerrar los ocho clientes, el dispatcher terminó normalmente por inactividad.

## Por qué el escenario del usuario sí aumenta el riesgo

### Dos niveles de cola, no solo el socket

`forum-client.mjs:67` sigue leyendo y parseando mensajes del socket mientras los handlers previos esperan. Los retiene en una cadena de promesas sin límite. El dispatcher ve que el socket se drena y sigue confirmando actualizaciones. Su límite `writableLength` no protege esta cola dentro del cliente.

En el index, los mensajes de texto pueden terminar rápidamente el handler de entrada, pero quedan retenidos en `queuedTelegramTurns` si Pi está ocupado. La sonda anterior ya confirmó 201 turnos aceptados. Por tanto, arreglar únicamente una de las dos colas no resuelve el problema completo.

Para descargas lentas, la primera cola puede retener mensajes posteriores, incluido `/stop`: ese comando usa la misma ruta serializada. La prueba bloquea artificialmente el consumidor; una descarga lenta es un ejemplo de cómo esa condición puede aparecer en la implementación real.

### Los recursos de cada sesión se suman

Cada sesión conectada tiene su estado de extensión: cola, previews, temporizadores y adjuntos. También está el consumo del propio Pi, historial, llamadas al modelo y herramientas ejecutadas. No hay presupuesto global de RAM/concurrencia entre las sesiones.

Con N turnos simultáneamente activos:

- Typing: aproximadamente N/4 solicitudes por segundo, mientras el bucle está activo. Sin control de in-flight, se acumulan si tardan. La sonda anterior reprodujo 26 simultáneas en UNA instancia con 25 ticks simulados; multiplicar por N es una extrapolación, no una medición de producción.
- Previews: pueden programarse aproximadamente cada 750 ms por sesión durante streaming. Ocho sesiones podrían generar del orden de 10,7 flushes/s bajo flujo continuo; un flush puede hacer más de una llamada por fallback/finalización. Es una estimación del temporizador, no tráfico medido aquí.
- El bot/chat comparte límites de Telegram: varias sesiones pueden provocar 429. El index no aplica una política global de rate limiting ni espera coordinada de retry_after. Los fallos de preview se silencian y otros se propagan. Esto puede atascar respuestas o generar más trabajo, aunque no demuestra un fallo del SO.
- Adjuntos y base64 se acumulan por sesión. Los archivos salientes grandes se leen antes de subirlos y no tienen techo local de bytes. Varias subidas simultáneas multiplican los picos de RAM.
- Las herramientas del agente pueden arrancar builds, tests, servidores o modelos locales en cada sesión. El dispatcher no limita esos recursos; esa carga también debe medirse, no atribuir todo al puente.

### Lo que NO se encontró

- No hay un poller por tópico: comparten uno.
- El dispatcher no crea un proceso por mensaje/tópico. Los procesos Pi son los clientes que el usuario abre por separado.
- No se reprodujo tormenta de procesos, mezcla de sesiones, bucle de mensajes ni consumo desmedido en la prueba acotada.
- Muchos tópicos creados pero sin clientes asociados no generan agentes trabajando. Sus mensajes se ignoran por diseño, aunque las actualizaciones recibidas avanzan el cursor.

## Relación con el congelamiento

**La hipótesis de agotamiento de recursos durante actividad simultánea es técnicamente plausible y más relevante que observar RAM con el puente desconectado. Hay defectos concretos que la permiten, pero no se reprodujo el congelamiento ni el remonte a solo lectura.**

Solo texto y pocos mensajes: el overhead del puente por sí solo no ofrece aquí evidencia de agotamiento de 32 GiB. Muchos adjuntos, sesiones largas, red bloqueada o herramientas pesadas en paralelo: riesgo considerablemente mayor. No se conoce aún cuál era la carga real del usuario.

Un remonte Btrfs a solo lectura sigue requiriendo evidencia del kernel/almacenamiento. La presión de RAM podría ser un desencadenante indirecto, pero no debe afirmarse que sea la causa sin correlación temporal. Mantener las recomendaciones de backup y SMART del informe principal.

## Prioridades antes de uso intensivo

1. Limitar mensajes Y bytes pendientes por cliente y por sesión. Definir rechazo/pausa y confirmaciones sin perder mensajes silenciosamente.
2. Limitar tamaño y concurrencia de transferencias; cancelar descargas al cerrar la sesión y dar prioridad efectiva a stop.
3. Typing y preview con un único request en vuelo, deadline, coalescencia y cancelación.
4. Coordinar las llamadas salientes por bot/chat y respetar retry_after. Actualmente las respuestas salen de cada Pi, no del dispatcher común.
5. Manejar rechazos de callbacks y asegurar cleanup aunque falle la red.
6. Si las herramientas/modelos locales son pesados, presupuestos de recursos del conjunto de procesos (cgroups), no solo heap Node.

Para identificar causalidad: comparar una sesión activa contra varias con carga comparable, midiendo RSS/PSS agregado, procesos hijos, presión de memoria/I/O, swap, cola por sesión y errores de Telegram. Registrar fuera del disco afectado cuando sea posible. No hacer una prueba de saturación deliberada en el equipo que ya se congela.

## Estado

Solo se añadió una sonda y este documento; producción sigue sin modificar. No se conectó el bot real. Los hallazgos de límites de recursos siguen pendientes de corrección; esta prueba NO certifica seguro el uso intensivo multi-sesión.
