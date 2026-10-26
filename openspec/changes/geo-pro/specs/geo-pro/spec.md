# Spec: geo-pro

## ADDED Requirements

### Requirement: REQ-H-01 — Ubicación estructurada, sin coordenadas

El modelo MUST devolver por reclamo una `ubicacion` con `tipo` (`calle_altura`, `cruce`, `lugar`, `villa`, `barrio`, `lineal`, `ninguna`) y los campos de su tipo; MUST NOT devolver coordenadas ni inventar una altura o un cruce. Un reclamo MUST tener algún lugar nombrado. Lo que no valida en el servidor MUST quedar `ninguna`.

#### Scenario: Un horario no es una altura

- GIVEN el comentario "el camión pasa por Serrano hasta las 18"
- WHEN se analiza
- THEN la ubicación no tiene altura 18 (es `lineal`, una calle sola) y el reclamo queda sin ubicar con motivo `lineal`

---

### Requirement: REQ-H-02 — El resolver, en orden

El servidor MUST resolver en este orden: villa, calle y altura o cruce (USIG), lugar con nombre (índice local), barrio (mención territorial, sin punto), y si no, sin ubicar con motivo (`lineal`, `fuera_de_caba`, `ambigua`, `no_encontrada`, `sin_direccion`). Todo punto MUST llevar comuna y barrio. Con más de 2 opciones de USIG MUST quedar `ambigua`, sin elegir. El (0,0) MUST NOT ser un punto.

#### Scenario: Un lugar con nombre

- GIVEN el reclamo "la cancha de Huracán es un desastre"
- WHEN se resuelve
- THEN cae en el estadio Tomás A. Ducó con precisión `lugar`, en Parque Patricios, comuna 4

#### Scenario: Una villa

- GIVEN el reclamo "en la 1 11 14 no pasa la basura"
- WHEN se resuelve
- THEN cae en el centroide de la Villa 1-11-14 con precisión `area`, y "1 11 14" no llega a USIG como altura

---

### Requirement: REQ-H-03 — Datos abiertos cacheados

Los datasets MUST bajarse a `data/geo/` y MUST NOT volver a bajarse antes de 30 días. Los filtros MUST aplicarse al cargar, con las listas de `config/geo-config.json` (pisadas por `data/geo/geo-config.json` si existe). Una falla pasajera de USIG MUST NOT cachearse.

---

### Requirement: REQ-H-04 — Precisión en el Mapa

El pin MUST verse según la precisión (sólido para `puntual` y `cruce`, con halo para `lugar`, con halo grande para `area`) y el tooltip y el pop-up MUST decirla. El Mapa MUST tener la vista "Por comunas" (ubicados más menciones territoriales, sin los de fuera de la Ciudad) y el filtro "Precisión".

---

### Requirement: REQ-H-05 — Sin ubicar, corregir y descartar

El Mapa MUST listar los reclamos sin ubicar con su texto, motivo y fecha (las menciones de solo un barrio en su grupo; los de fuera de la Ciudad con su motivo). "Corregir dirección" MUST volver a resolver lo escrito con el mismo resolver y marcar quién lo corrigió, sin que el correo salga a la API. "Descartar" MUST guardar el motivo.

---

### Requirement: REQ-H-06 — El reproceso, una vez

La pasada del modelo sobre los reclamos sin punto MUST correr una sola vez, sobre una copia de la base, con el costo exacto informado y el OK del dueño antes; MUST NOT volver a clasificar tono ni temas. El piloto MUST aplicarla una sola vez al arrancar; un reclamo con punto MUST conservarlo.
