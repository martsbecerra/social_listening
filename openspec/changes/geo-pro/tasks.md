# Tasks: geo-pro

Rama `geo-pro`, en una carpeta de trabajo aparte. Sin revisor
independiente ni agentes en paralelo (decisión del dueño). Suite en modo
liviano, un actor por vez. Sin Apify; el modelo, solo en la corrida
autorizada del reproceso, con el costo exacto y el OK del dueño antes.

## Phase 0: plan y decisiones

- [x] 0.1 Plan archivo por archivo y diez decisiones; respuestas del dueño (25/10/2026): listas en `config/geo-config.json` con `data/geo/geo-config.json` encima; conversión local verificada contra USIG en tres puntos; reclamo = problema + algún lugar; solo barrio sin pin, en "Por comunas" y en su grupo de "Sin ubicar"; reproceso sobre la copia, a un JSON que el piloto aplica una vez; trenes de la Ciudad y escuelas solo con indicador; `lugares_extra` con estadios y unos 30 hitos; columna `descarte_motivo`; los de fuera de la Ciudad en "Sin ubicar"; nombres informales de barrio

## Phase 1: base y piezas sin red

- [x] 1.1 Columnas nuevas, `lugar_cache` y la precisión nueva
- [x] 1.2 Texto, proyecciones y `config/geo-config.json`

## Phase 2: datasets y resolver

- [x] 2.1 Datasets con caché de 30 días, villas y lugares con nombre
- [x] 2.2 USIG, el resolver y el worker

## Phase 3: modelo y API

- [x] 3.1 La ubicación estructurada en la tanda de Instagram
- [x] 3.2 Filtro de precisión, corregir, descartar y las comunas

## Phase 4: pantalla

- [x] 4.1 Mapa: precisión, "Por comunas", "Sin ubicar" y el filtro
- [x] 4.2 El mapita del análisis

## Phase 5: reproceso

- [x] 5.1 El script (costo, simulado) y la aplicación al arrancar
- [x] 5.2 La corrida autorizada (25/10/2026, tope US$ 0,40 del dueño, sobre la copia): 136 reclamos (5 de Instagram, 131 de X), 10 llamadas de 15, ninguna fallida, US$ 0,262 (estimado 0,20 a 0,39). Aplicada sobre una copia: Instagram 3 de 5 con punto (2 lugar, 1 cruce), 1 mención de barrio, 1 no encontrada; X 131 de 257 (antes 126: +2 cruce, +2 área, +1 puntual), 3 menciones de barrio, sin ubicar 113 sin dirección, 7 fuera de la Ciudad, 3 no encontradas. Siete arreglos salieron de ahí (design.md, "Lo que salió de la corrida"). El JSON quedó en data/geo/ del piloto: se aplica al arrancar con la H

## Phase 6: cierre

- [ ] 6.1 Suite con `IG_ACTOR=apidojo` y `apify`; capturas a 1366 y 375 px en claro y oscuro
- [x] 6.2 CLAUDE.md ("Georreferenciación"), README
- [ ] 6.3 PR sin mergear
