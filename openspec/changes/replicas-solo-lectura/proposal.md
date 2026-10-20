# Proposal: replicas-solo-lectura

## Intent

Que varias personas de una organización usen la app desde la red de la
organización sin desplegarla en un servidor. Hoy el server corre en la PC
de Martin, en su casa, y no hay forma de llegar a él: un túnel (Cloudflare
Tunnel, Tailscale) está bloqueado en esa red.

La PC de Martin sigue siendo la única que monitorea (Apify, LLM, scheduler)
y, al terminar cada ciclo, publica una foto de los datos en un repo privado
de GitHub. Cada persona instala en su máquina un mini-servidor en **modo
réplica**: solo lectura, solo `localhost`, sin claves ni scheduler, que se
trae la foto nueva y se reinicia con ella.

Esta etapa es de **solo lectura**. Las escrituras (sentimiento, ignorar,
reclamos) con un registro de eventos por usuario quedan para una etapa
siguiente, que se construye encima de esta sin rehacerla.

## Scope

### In Scope

- Interruptor `APP_MODE` (`principal` default | `replica`), validado al
  arrancar como `IG_ACTOR` y `REFRESH_MODE`
- Publicación al final de cada ciclo en la PC principal
  (`REPLICA_PUBLISH_DIR`): base copiada con `VACUUM INTO` y sin
  `magic_links`, config del monitoreo, `account-types.json`, fotos
  (`data/media/`) y `snapshot.json`; un commit único en la rama `snapshot`
  con `push --force`. Nunca frena ni rompe un ciclo
- Modo réplica en `server.js`: sin scheduler, sin keep-awake, sin claves,
  escucha en `127.0.0.1`, sin login, 403 a todo lo que no sea GET/HEAD,
  `Host` restringido a localhost
- Sincronización antes de arrancar (`scripts/replica-sync.js`): clon o
  fetch superficial del repo de datos, `integrity_check`, reemplazo atómico
  de la base, espejo de las fotos, copia de la config
- Sondeo cada `REPLICA_POLL_MINUTES`: si hay un snapshot nuevo, el server
  sale con código 75 y el lanzador lo reinicia con los datos nuevos
- `GET /api/app/mode` y frontend de solo lectura: controles de escritura
  ocultos, franja "Copia de solo lectura · Datos al ..." y aviso de versión
  nueva de la app
- Instalador para Windows: zip con Node portable, MinGit portable, la app y
  sus dependencias de producción; `instalar.ps1` y `iniciar-replica.bat`
- `.env.example`, README, CLAUDE.md, este SDD

### Out of Scope

- Escrituras desde las réplicas (etapa siguiente: eventos por usuario)
- Actualización automática del código de la réplica: se corre el
  instalador nuevo; la réplica solo avisa que hay otra versión
- Las librerías que el frontend carga de CDN (Tabulator, Leaflet) y los
  mapas base: si la red las bloquea, es otro cambio
- Retención de fotos viejas en el snapshot (se agrega si el tamaño lo pide)

## Capabilities

### New Capabilities

- `replicas-solo-lectura`: publicación del snapshot, modo réplica de solo
  lectura, sincronización, sondeo con reinicio e instalador

### Modified Capabilities

- Ciclo de monitoreo (`src/scheduler.js`): al cerrar, publica el snapshot
  si `REPLICA_PUBLISH_DIR` está configurado
- `server.js`: arranque según `APP_MODE`

## Approach

1. `src/appMode.js` (`APP_MODE`), validado en `server.js` antes de cargar
   los módulos.
2. `src/replicaGit.js`: corre git con el token por variables de entorno
   (`GIT_CONFIG_*`, `http.extraHeader`), nunca en argumentos ni URL.
3. `src/replicaPublish.js`: arma la carpeta de publicación y hace el
   commit único con force-push; lo llama `runCycleUnlocked` al cerrar.
4. `src/replicaGuard.js`: middleware del modo réplica (Host, métodos,
   sesión fija, redirección de la página de login).
5. `src/replicaSync.js` + `scripts/replica-sync.js`: traer y aplicar el
   snapshot. `src/replicaPoller.js`: sondeo y salida 75.
6. `src/appVersion.js` y `src/replicaRoutes.js` (`GET /api/app/mode`).
7. Frontend: `main.js` consulta el modo y marca la página; CSS esconde.
8. `installer/`: armado del zip, instalación y lanzador.

## Affected Areas

- `openspec/changes/replicas-solo-lectura/` — este SDD
- `src/appMode.js`, `src/appVersion.js`, `src/replicaGit.js`,
  `src/replicaPublish.js`, `src/replicaGuard.js`, `src/replicaSync.js`,
  `src/replicaPoller.js`, `src/replicaRoutes.js` (nuevos)
- `src/scheduler.js` (publicación al cerrar el ciclo), `src/db.js`
  (exporta `DB_PATH`)
- `server.js`, `public/js/main.js`, `public/css/styles.css`
- `scripts/replica-sync.js`, `installer/` (nuevos)
- `test/appMode.test.js`, `test/appVersion.test.js`,
  `test/replicaGit.test.js`, `test/replicaPublish.test.js`,
  `test/replicaGuard.test.js`, `test/replicaSync.test.js`,
  `test/replicaPoller.test.js`, `test/replicaRoutes.test.js` (nuevos)
- `.env.example`, `README.md`, `CLAUDE.md`

## Risks

- Que la red de la organización también bloquee GitHub. Se verifica antes
  de instalar (paso 0, a mano): si está bloqueado, el plan se cae.
- Crecimiento de `data/media/` (hasta ~125 KB por posteo). Con force-push
  el repo guarda solo la foto actual y git transfiere solo las fotos nuevas,
  pero la primera descarga es todo. Si pesa varios GB, retención.
- Los datos llegan con la demora del ciclo más el sondeo, y solo mientras
  la PC de Martin esté prendida.
- El token de las réplicas es compartido y de solo lectura: si una máquina
  se compromete, se lee el repo de datos y se rota el token.

## Rollback Plan

En la PC principal, sacar `REPLICA_PUBLISH_DIR` del `.env` y reiniciar: el
ciclo vuelve a ser el de antes. `APP_MODE` vacío es `principal`: el server
se comporta exactamente como hoy. Las réplicas se desinstalan borrando
`%LOCALAPPDATA%\SocialListening` y sus accesos directos.

## Dependencies

- Un repo privado de GitHub solo de datos, creado por el dueño, y un token
  fine-grained de solo lectura de ese repo para las réplicas.
- git en la PC principal, autenticado contra GitHub.

## Success Criteria

- [ ] Con `APP_MODE` vacío, la suite pasa y el server se comporta como antes
- [ ] Al cerrar un ciclo con `REPLICA_PUBLISH_DIR`, la carpeta tiene la base sin `magic_links`, la config, las fotos y `snapshot.json`, y se hace un commit único con force-push; un fallo no frena el ciclo
- [ ] En réplica, todo pedido que no sea GET/HEAD responde 403 y nada llama a Apify ni al LLM
- [ ] La réplica aplica un snapshot nuevo con reemplazo atómico y arranca igual sin red con lo último que tiene
- [ ] El token nunca aparece en argumentos, URLs ni logs
- [ ] Probado en el navegador con una réplica de prueba: controles de escritura ocultos y franja con la fecha de los datos
- [ ] Paso 0 verificado por el dueño desde la red de la organización
