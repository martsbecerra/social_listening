# Tasks: geo-pro

Rama `geo-pro`, en una carpeta de trabajo aparte. Sin revisor
independiente ni agentes en paralelo (decisión del dueño). Suite en modo
liviano, un actor por vez. Sin Apify; el modelo, solo en la corrida
autorizada del reproceso, con el costo exacto y el OK del dueño antes.

## Phase 0: plan y decisiones

- [x] 0.1 Plan archivo por archivo y diez decisiones; respuestas del dueño (25/10/2026): listas en `config/geo-config.json` con `data/geo/geo-config.json` encima; conversión local verificada contra USIG en tres puntos; reclamo = problema + algún lugar; solo barrio sin pin, en "Por comunas" y en su grupo de "Sin ubicar"; reproceso sobre la copia, a un JSON que el piloto aplica una vez; trenes de la Ciudad y escuelas solo con indicador; `lugares_extra` con estadios y unos 30 hitos; columna `descarte_motivo`; los de fuera de la Ciudad en "Sin ubicar"; nombres informales de barrio

## Phase 1: base y piezas sin red

- [ ] 1.1 Columnas nuevas, `lugar_cache` y la precisión nueva
- [ ] 1.2 Texto, proyecciones y `config/geo-config.json`

## Phase 2: datasets y resolver

- [ ] 2.1 Datasets con caché de 30 días, villas y lugares con nombre
- [ ] 2.2 USIG, el resolver y el worker

## Phase 3: modelo y API

- [ ] 3.1 La ubicación estructurada en la tanda de Instagram
- [ ] 3.2 Filtro de precisión, corregir, descartar y las comunas

## Phase 4: pantalla

- [ ] 4.1 Mapa: precisión, "Por comunas", "Sin ubicar" y el filtro
- [ ] 4.2 El mapita del análisis

## Phase 5: reproceso

- [ ] 5.1 El script (costo, simulado) y la aplicación al arrancar
- [ ] 5.2 La corrida autorizada y el resumen ("N de M ubicados" por plataforma, por precisión, menciones, sin ubicar por motivo y los 5 de Instagram)

## Phase 6: cierre

- [ ] 6.1 Suite con `IG_ACTOR=apidojo` y `apify`; capturas a 1366 y 375 px en claro y oscuro
- [ ] 6.2 CLAUDE.md ("Georreferenciación"), README
- [ ] 6.3 PR sin mergear
