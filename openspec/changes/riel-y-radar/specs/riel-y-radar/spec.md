# Spec: riel-y-radar

Navegación por riel, panel de fuentes y radar del día en el Monitoreo de Instagram (`public/instagram.html`), y el pie nuevo de las páginas con sesión. No cambia el ciclo, Apify ni el esquema de la base.

---

## ADDED Requirements

### Requirement: REQ-RIEL-01 — Riel y solapas

`instagram.html` MUST mostrar un riel lateral oscuro en lugar de la barra de solapas, con, en este orden: Monitoreo (medidor), Estadísticas (línea en alza), Mapa (pin) y Análisis (lupa). Debajo de un separador MUST ir "Fuentes" con tres botones con contador (Búsquedas, Cuentas, Palabras) y, al final, "DGAYD 2026". El riel MUST quedar fijo bajo la cabecera, con el alto de la ventana, y su columna MUST verse oscura hasta el final de la página. La solapa por defecto MUST ser Monitoreo. La solapa abierta MUST quedar en el hash (`#tab-monitoring`, `#tab-claims-map`, `#tab-analysis`) y un cambio de hash MUST abrir esa solapa sin recargar. El botón activo MUST llevar `aria-current="page"`.

#### Scenario: Entrar sin hash

- GIVEN `instagram.html` sin hash
- WHEN carga la página
- THEN se ve el Monitoreo y el riel lo marca activo

#### Scenario: Enlace del pie a otra solapa

- GIVEN el Monitoreo abierto
- WHEN se toca "Mapa de reclamos" en el pie
- THEN se abre el Mapa sin recargar la página

---

### Requirement: REQ-RIEL-02 — Estadísticas deshabilitado

Hasta que exista su pantalla, el botón Estadísticas del riel y su enlace en el pie MUST verse atenuados, con `aria-disabled="true"` y `title="Pronto"`, y un clic MUST NOT cambiar de solapa ni mostrar ninguna pantalla.

---

### Requirement: REQ-RIEL-03 — Panel de fuentes

Los botones de Fuentes MUST abrir un panel desde el riel con, arriba, "Búsquedas por palabra clave" y su explicación, y abajo el bloque "Guía para el clasificador" con cuentas trackeadas y palabras clave/hashtags. Al abrir desde un botón, el panel MUST hacer scroll a ese grupo y enfocar su campo. El panel MUST cerrarse con Esc, con un clic afuera y con la ✕. Las listas MUST mostrarse completas, sin "Ver todas". Agregar, quitar, validar una cuenta y los mensajes de error MUST funcionar igual que en las cajas de antes (mismos ids y misma lógica de `monitoring.js`). Los contadores del riel MUST seguir a las listas.

#### Scenario: Agregar un término

- GIVEN el panel abierto en Búsquedas
- WHEN se agrega un término
- THEN aparece en la lista y el contador de Búsquedas sube en uno

---

### Requirement: REQ-RIEL-04 — Estado de la escucha

`GET /api/monitoring/status` MUST devolver `nextRunAt`, `lastRunAt` (fin de la última corrida terminada de la plataforma pedida, guardada en `monitoring_runs`, o null) y `runHours` (las horas de `MONITOR_CRON`, ordenadas). La franja MUST decir "Escuchando. Última corrida a las HH:MM, la próxima a las HH:MM." con esos datos, y solo la próxima si no hay última. MUST NOT mostrar horas que no salgan del backend. El recuadro de progreso de "Actualizar ahora" MUST estar dentro de la franja y comportarse igual que antes.

#### Scenario: Corrida de varias redes

- GIVEN una corrida terminada con `plataforma` "instagram,x"
- WHEN se pide el estado de Instagram
- THEN `lastRunAt` es el fin de esa corrida

---

### Requirement: REQ-RIEL-05 — Qué dibuja el radar

El radar MUST dibujar las publicaciones de la tabla ya filtrada que se publicaron hoy en hora de Argentina: x = hora de `posted_at`, y = `benchmark.top.ratio` en escala logarítmica entre 0,6× y 3×, con línea punteada de "alto" en 1,5× y de "lo habitual" en 1×; color = sentimiento (null = neutral); radio = raíz de los comentarios. Un posteo de alcance alto MUST llevar halo y un anillo que late. Un posteo sin `benchmark.top` MUST dibujarse como círculo hueco sobre "lo habitual". La línea de "ahora" MUST marcar la hora real, con la zona de la derecha atenuada. Las horas de `runHours` MUST marcarse debajo del eje, "corrida" las pasadas y "próxima" las que faltan.

#### Scenario: Un filtro tapa posteos

- GIVEN cinco posteos de hoy, dos negativos
- WHEN se filtra por Negativo
- THEN el radar muestra dos pulsos

---

### Requirement: REQ-RIEL-06 — Interacción con el radar

Con el mouse sobre un pulso, el radar MUST mostrar un tooltip con cuenta, hora, título, likes, comentarios y alcance (o el aviso "sin referencia de su cuenta"), y MUST resaltar con la clase `hot` la tira, la tarjeta o la fila de ese posteo. Con el mouse sobre una tira de "Se despegaron" o una tarjeta del feed, su pulso MUST resaltarse. Un clic en un pulso MUST abrir el pop-up de ese posteo solo (`openFeedPopSolo`). Todo dato del posteo MUST entrar por `textContent`.

---

### Requirement: REQ-RIEL-07 — El radar durante "Actualizar ahora"

Al lanzar "Actualizar ahora", el radar MUST barrer una vez de izquierda a derecha. Al terminar, los posteos de hoy cuyos ids no estaban antes de la corrida MUST entrar con tres ondas, la línea de "ahora" MUST quedar en la hora de fin y la línea de estado MUST actualizarse.

---

### Requirement: REQ-RIEL-08 — Vacío y movimiento reducido

Sin posteos de hoy, la franja MUST decir "Todavía no hay publicaciones de hoy. La próxima corrida es a las HH:MM."; si el navegador no puede dibujar el canvas, "No se puede dibujar el radar en este navegador.". MUST NOT quedar un recuadro negro sin texto. Con `prefers-reduced-motion` MUST NOT haber latido, barrido ni ondas, ni en el radar ni en el medidor de alcance.

---

### Requirement: REQ-RIEL-09 — "Se despegaron" en tiras

"Se despegaron" MUST mostrar hasta 4 tiras de los posteos con `benchmark.top.level === 'alto'`, de mayor a menor razón, cada una con la razón grande y su métrica, el título, la cuenta, la hora, el valor contra la mediana y un selector de sentimiento que guarda como el de la tabla. Un clic en la tira, salvo en el selector, MUST abrir el pop-up de ese posteo solo.

---

### Requirement: REQ-RIEL-10 — Medidor de alcance

El alcance de un posteo (`postReach`) MUST mostrarse con un medidor de cinco barras y su nivel (Alto, Medio, Bajo): en el pie de la tarjeta del feed, al lado del selector de sentimiento, y en una columna "Alcance" de la tabla, solo en Instagram, que ordena por nivel y razón. En "alto" las cinco barras MUST latir y brillar, en "medio" la tercera MUST respirar y en "bajo" MUST quedar quieto. Sin referencia MUST mostrar "—". El medidor MUST NOT sumarle alto a la tarjeta de 240 px.

---

### Requirement: REQ-RIEL-11 — Lista de publicaciones

El título de la lista MUST ser "Publicaciones detectadas", con "N de M" al lado. Feed | Tabla, los filtros (Sentimiento, Alcance, Cuenta, Desde, Hasta), el orden del feed, el buscador y Limpiar MUST ir en una fila. Feed MUST ir primero y ser la vista por defecto cuando no hay una elegida antes.

---

### Requirement: REQ-RIEL-12 — Pie

`instagram.html`, `x.html` y `dashboard.html` MUST mostrar el pie armado por `footer.js`: la marca, la frase con "DGAYD", las corridas por día con sus horas, y las columnas Secciones, Fuentes, Plataformas (Facebook y TikTok sin enlace) y Cuenta (nombre del usuario y "Cerrar sesión"). Los enlaces MUST navegar de verdad: a la solapa, al panel de fuentes, a la página de la plataforma o cerrar la sesión. MUST NOT aparecer "DGAND".
