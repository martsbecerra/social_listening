# Spec: alcance-colchon

Regla del alcance de likes y de comentarios de un posteo contra la mediana de su cuenta. Solo Instagram (la única red con benchmark). No cambia las medianas, la base ni Apify.

---

## ADDED Requirements

### Requirement: REQ-ALC-01 — Razón con colchón

La razón de una métrica MUST ser `(valor + colchón) / (mediana de la cuenta + colchón)`, con el colchón de esa métrica (por defecto 2000 para likes y 300 para comentarios). Likes y comentarios MUST calcularse por separado. Con colchón 0 y mediana 0, la razón MUST calcularse contra 1 y nunca dividir por cero.

#### Scenario: Cuenta chica

- GIVEN una cuenta con mediana de 2 likes
- WHEN un posteo suyo tiene 100 likes
- THEN la razón es 2100 / 2002 (1,04) y el nivel de likes es bajo

#### Scenario: Cuenta grande

- GIVEN una cuenta con mediana de 3.206 likes
- WHEN un posteo suyo tiene 6.136 likes
- THEN la razón es 1,56 y el nivel de likes es alto

#### Scenario: Mediana 0

- GIVEN una cuenta con mediana de 0 comentarios
- WHEN un posteo suyo tiene 0 comentarios
- THEN la razón es 1 y el nivel de comentarios es bajo

---

### Requirement: REQ-ALC-02 — Niveles: alto con piso, medio y bajo

El nivel de una métrica MUST ser `alto` si la razón llega al corte de alto (por defecto 1,5) y el valor llega al piso de esa métrica (por defecto 1000 likes, 150 comentarios); `normal` (en pantalla "medio") si la razón llega al corte de medio (por defecto 1,1); `bajo` en el resto. Una razón igual al corte MUST contar como alcanzado. Una métrica que llega al corte de alto sin llegar a su piso MUST quedar en `normal`. La etiqueta del posteo MUST combinar las dos métricas como antes: alto si alguna da alto, bajo solo si las dos dan bajo; una métrica sin referencia no cuenta.

#### Scenario: Bordes

- GIVEN una cuenta con mediana 0 de likes
- WHEN sus posteos tienen 180, 200 y 1.000 likes
- THEN las razones son 1,09, 1,10 y 1,50 y los niveles bajo, medio y alto

#### Scenario: Piso

- GIVEN el colchón de likes en 200 y el piso en 1000
- WHEN un posteo tiene 600 likes contra una mediana de 0
- THEN la razón es 4 y el nivel es medio, no alto

#### Scenario: Una métrica alcanza

- GIVEN un posteo con likes en bajo y comentarios en alto
- WHEN se arma su etiqueta
- THEN es "Alcance alto", por comentarios

---

### Requirement: REQ-ALC-03 — Números en el `.env`

Los dos colchones, los dos pisos y los dos cortes MUST leerse del entorno (`REACH_LIKES_CUSHION`, `REACH_LIKES_FLOOR`, `REACH_COMMENTS_CUSHION`, `REACH_COMMENTS_FLOOR`, `REACH_HIGH_RATIO`, `REACH_MID_RATIO`), con los valores por defecto 2000, 1000, 300, 150, 1.5 y 1.1 cuando faltan o están vacíos. Colchones y pisos MUST ser enteros mayores o iguales a 0, sin separador de miles. Los cortes MUST ser mayores que 0 y el de medio menor que el de alto; MAY escribirse con coma decimal. Un valor inválido MUST abortar el arranque con un mensaje que nombre la variable. Al arrancar, la app MUST mostrar los números en uso. Un cambio MUST valer desde el arranque siguiente sin recalcular nada.

#### Scenario: Separador de miles

- GIVEN `REACH_LIKES_CUSHION=2.000` en el `.env`
- WHEN se arranca la app
- THEN no arranca y el mensaje nombra `REACH_LIKES_CUSHION`

#### Scenario: Calibrar

- GIVEN `REACH_MID_RATIO=1,25` en el `.env`
- WHEN se arranca la app y se abre el Monitoreo
- THEN un posteo con razón 1,2 lleva "Alcance bajo", sin haber corrido ningún recálculo

---

### Requirement: REQ-ALC-04 — Lo que recibe la pantalla

Cada métrica con referencia del `benchmark` de un posteo MUST llevar `level`, `value`, `median`, `ratio`, `cushion` y `floor`. Una métrica sin referencia MUST seguir como antes (`sin-referencia` con su `reason`), sin razón ni colchón. El frontend MUST NOT tener ningún corte, colchón ni piso propio.

#### Scenario: Likes ocultos

- GIVEN un posteo con likes sin dato y 500 comentarios contra una mediana de 100
- WHEN se arma su `benchmark`
- THEN likes es `sin-referencia` por `sin-dato` y comentarios es alto, con razón 2 y colchón 300

---

### Requirement: REQ-ALC-05 — "Se despegaron" con la regla nueva

`benchmark.top` MUST ser la métrica de mejor nivel y, a igual nivel, la de mayor razón (empate: comentarios), con su `level`. "Se despegaron" MUST mostrar solo posteos cuyo `top.level` es `alto`, los de mayor razón primero, con el valor y la mediana reales de esa métrica.

#### Scenario: Razón alta sin piso

- GIVEN un posteo con likes en medio (razón 4, frenado por el piso) y comentarios en alto (razón 1,6)
- WHEN se elige la métrica que decide
- THEN es comentarios, con nivel alto

#### Scenario: Cuenta chica ya no se destaca

- GIVEN un posteo con 180 likes contra una mediana de 1,5 y 3 comentarios contra 0
- WHEN se arma "Se despegaron"
- THEN ese posteo no aparece

---

### Requirement: REQ-ALC-06 — La razón en pantalla

La razón MUST mostrarse con dos decimales cortados, no redondeados, para que el número nunca quede del otro lado del corte que la etiqueta. Donde se muestra, la pantalla MUST dejar a mano con qué se calculó: en el pop-up y en el detalle de la tabla, la mediana real de la cuenta y el colchón; en la tarjeta y en "Se despegaron", al pasar el mouse. Ningún texto MUST presentar la razón como "veces lo habitual". En el pop-up, la razón MUST ir también junto a la etiqueta de alcance. El orden "Mayor alcance" MUST ir primero por la etiqueta (alto, medio, bajo, sin etiqueta) y después por la razón.

#### Scenario: Borde que no se contradice

- GIVEN un posteo con 32 comentarios contra una mediana de 3 (razón 1,0957)
- WHEN se muestra su tarjeta
- THEN dice "Alcance bajo" y "1,09×", no "1,10×"

#### Scenario: Pop-up

- GIVEN un posteo con 229 likes contra una mediana de 21
- WHEN se abre su pop-up
- THEN la etiqueta dice "Alcance medio · 1,10× por likes" y la fila de likes muestra "Mediana de la cuenta: 21" y el colchón de 2.000
