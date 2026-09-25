# Simulación acotada de seis tópicos y nuevo incidente

## Nuevo incidente

Al consultar el equipo a las 09:26 del 24/09/2026, uptime era de unos siete minutos. El journal muestra un arranque nuevo a las 09:18:40 y el anterior termina a las 09:16:14. Esto confirma un reinicio entre ambas consultas, no que Telegram lo haya provocado ni si fue reinicio manual tras un cierre del escritorio.

En el final consultado no aparecen OOM, abortos Btrfs o fallos NVMe explicativos. Hay caída y recuperación del enlace Ethernet a las 09:13:04/09:13:09 y errores de red/DNS de Tailscale hasta el final. Esos errores no demuestran la causa del cierre de aplicaciones. Tampoco hay un cierre ordenado visible en las últimas 45 entradas.

La ausencia de errores persistidos no descarta un fallo del kernel/disco. Si el puente estaba desconectado cuando ocurrió, se debilita la hipótesis de que los tópicos activos sean necesarios para desencadenarlo. Hace falta confirmar ese dato con el usuario.

## Prueba solicitada: seis tópicos

Se parametrizó audit/multi-topic-probe.mjs para 1–8 tópicos y se ejecutó con seis. Dispatcher y forum-client reales; Telegram y consumidores simulados, sin seis agentes Pi completos, sin modelos, builds o adjuntos grandes.

Comando ejecutado desde la raíz del repositorio:

```sh
systemd-run --user --wait --pipe --unit=pi-telegram-audit-six \
  --property=MemoryMax=256M --property=MemorySwapMax=0 \
  --property=CPUQuota=50% --property=TasksMax=48 \
  --property=RuntimeMaxSec=25s --property=WorkingDirectory="$PWD" \
  --setenv=AUDIT_EXPECT_LIMITS=1 \
  /usr/bin/node --max-old-space-size=96 "$PWD/audit/multi-topic-probe.mjs" 6
```

La sonda verificó memory.max=268435456 y memory.swap.max=0 en su cgroup. También mostró cpu.max=50000/100000 y pids.max=48. Estos límites alcanzan el harness y su subprocess dispatcher. Son límites de recursos, no garantía contra un defecto subyacente del hardware/kernel.

Resultados:

- Éxito, exit status 0; duración 5,474 segundos; CPU consumida 790 ms.
- Pico de memoria contabilizada por systemd/cgroup: 50,5 MiB; swap 0; eventos oom/oom_kill/max: 0 en las muestras.
- RSS dispatcher ~78,6 MiB inicialmente y ~73,1 MiB con mensajes pendientes; harness 68→72 MiB. RSS suma páginas compartidas y no equivale a memoria cargada al cgroup; no sumar estas métricas como si fueran memoria privada.
- 300 mensajes pequeños, 50 por tópico, correctamente aislados y entregados tras desbloquear consumidores.
- Un solo polling; seis consumidores bloqueados y 294 handlers esperando. El cursor avanzó sin esperar que terminaran: confirma el problema de falta de backpressure.
- Cierre normal del dispatcher al cerrar los seis clientes.

No se reprodujo el crash ni agotamiento de RAM. Una prueba de cinco segundos con 300 mensajes no descarta acumulación durante horas, múltiples agentes/herramientas reales, adjuntos o defectos de la máquina. No se modificó el puente de producción ni se conectó el bot real; solo la sonda de auditoría y este informe.
