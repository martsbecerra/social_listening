# Spec: sistema-visual-v4

El marco del diseño v4 (`design/social-listening-v4.html`) en todas las páginas: sistema visual, barra superior con la píldora de solapas, estado de la escucha, tema, tooltip, pie y login estático. No cambia el ciclo, Apify, el LLM ni el esquema de la base.

---

## ADDED Requirements

### Requirement: REQ-V4-01 — Sistema visual

`public/css/styles.css` MUST definir los tokens de la maqueta (claro y, con `data-theme="dark"`, oscuro) y sus componentes (`.card`, `.chip`, `.kpi`, `.seg`, `.btn`, `.field`, `.tip`, animaciones `rise`/`fadeIn`/`pop`/`slideIn`/`ping`/`draw`) con Sora, IBM Plex Sans e IBM Plex Mono. Todo color de la app MUST salir de los tokens, salvo los de marca de cada red, los de las categorías del mapa y el negro de las fotos. Tabulator, Leaflet, los modales y los formularios de X MUST verse con los mismos tokens en los dos temas, sin cambiar su comportamiento. Con `prefers-reduced-motion` toda animación y transición MUST durar un instante.

---

### Requirement: REQ-V4-02 — Barra superior y píldora

`instagram.html` y `x.html` MUST mostrar una barra superior (pegada arriba en escritorio; por debajo de 900 px MUST NOT quedar fija) con la marca (enlace al inicio), la píldora de solapas, el selector de plataforma (enlace al inicio), el estado de la escucha, el botón de tema y el usuario; `dashboard.html`, lo mismo sin píldora ni plataforma. En Instagram la píldora MUST tener, en orden, Monitoreo, Mapa, Análisis de publicación y Estadísticas (con `aria-disabled` y "pronto": un clic o la tecla 4 MUST NOT abrir nada). En X MUST tener Monitoreo, Mapa y Análisis, y abrir en Análisis. La solapa elegida MUST llevar `aria-selected="true"` y la pastilla de color MUST correrse a ella. Las teclas 1 a 4 MUST abrir la solapa de ese número, salvo mientras se escribe en un campo o con un pop-up o modal abierto. La solapa MUST quedar en el hash (`#tab-…`) y un cambio de hash MUST abrirla sin recargar. Por debajo de 980 px el usuario MUST mostrar solo sus iniciales.

#### Scenario: Tecla con un campo enfocado

- GIVEN el foco en el buscador del Monitoreo
- WHEN se escribe "2"
- THEN el "2" entra en el buscador y la solapa no cambia

---

### Requirement: REQ-V4-03 — Estado de la escucha

La barra MUST mostrar la hora (de Argentina) de la última corrida terminada: de esa plataforma en Instagram y X, de cualquiera en el inicio (`GET /api/monitoring/status` sin plataforma MUST leerla de `monitoring_runs`). Si terminó hace menos de 5 h MUST verse en verde "escuchando · HH:MM"; si no, en gris "última corrida · dd/mm HH:MM"; sin ninguna, "todavía no corrió"; sin respuesta del servidor, "—". MUST releerse cada 5 minutos y al terminar "Actualizar ahora".

#### Scenario: Corrida vieja

- GIVEN que la última corrida de Instagram terminó el 14/10 a las 10:58
- WHEN se abre `instagram.html` el 22/10
- THEN la barra dice "última corrida · 14/10 10:58" en gris

---

### Requirement: REQ-V4-04 — Tooltip

Un elemento con `data-tip` (y opcional `data-tip-title`) MUST mostrar el tooltip al pasar el mouse o al recibir el foco. Su contenido MUST entrar por `textContent`, nunca como HTML.

---

### Requirement: REQ-V4-05 — Pie

Las páginas con sesión MUST mostrar el pie de la maqueta: marca, el texto de la Dirección General de Análisis y Datos (DGAYD), "N corridas por día · horas h" desde `/api/footer-stats` (sin dato, la línea MUST NOT mostrarse), las columnas Secciones, Fuentes, Plataformas y Cuenta, y la línea final. Estadísticas, Facebook y TikTok MUST ir sin enlace, con "pronto". Los enlaces de Fuentes MUST abrir el Monitoreo, bajar a esa caja y enfocar su campo, también llegando desde otra página.

---

### Requirement: REQ-V4-06 — Monitoreo sin riel ni radar

El Monitoreo de Instagram MUST NOT tener riel, panel de fuentes, franja ni radar. Hasta la fase B MUST mostrar arriba "▶ Actualizar ahora" con el recuadro de progreso de siempre y tres cajas de fuentes (búsquedas, palabras clave y hashtags, cuentas) con las listas completas, con los mismos ids y comportamiento que antes.

---

### Requirement: REQ-V4-07 — Login estático

`index.html` y `login-verify.html` MUST mostrar una pantalla partida: a la izquierda la marca y el título sobre fondo oscuro, a la derecha la tarjeta con el formulario de siempre. El flujo del link mágico y sus mensajes MUST NOT cambiar.

---

### Requirement: REQ-V4-08 — Tema

La app MUST arrancar en claro aunque el sistema esté en oscuro; `<html>` MUST llevar siempre `data-theme="light"` o `"dark"`, y el CSS MUST NOT tener reglas con `prefers-color-scheme`. El botón de tema de la barra superior MUST pasarla a oscuro y volver, y la elección MUST recordarse en ese navegador para todas las páginas (también el login). Sin almacenamiento disponible MUST valer el claro.

#### Scenario: Volver otro día

- GIVEN que el usuario eligió el tema oscuro en `instagram.html`
- WHEN abre `x.html` o vuelve al día siguiente en el mismo navegador
- THEN la página ya aparece en oscuro, sin un instante en claro
