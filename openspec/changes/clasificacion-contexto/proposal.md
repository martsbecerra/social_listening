# Proposal: clasificacion-contexto

## Intent

Que la clasificación del monitoreo (¿este posteo habla de Jorge Macri o de
la gestión de la Ciudad?) la decida siempre el modelo, con contexto, en una
sola llamada que devuelve relevancia, título, sentimiento y motivo; y que el
prompt desambigüe la geografía.

**Por qué.** Hoy `src/classifier.js` tiene dos caminos y ninguno verifica
geografía: si el caption contiene una keyword literal el posteo entra sin
preguntarle nada al modelo (`classifyPost` solo pone título y sentimiento);
si no, `classifyRelevance` le pregunta a Haiku si habla del Jefe de
Gobierno. "Jefe de Gobierno" es también el título del titular de la Ciudad
de México, y "gobierno de la ciudad" o PDLC (Policía de la Ciudad) son
ambiguos entre ciudades: entran falsos positivos que el equipo hoy compensa
a mano con listas de exclusión en otra herramienta.

## Scope

### In Scope

- Una sola función `clasificarPosteo` (relevancia + título + sentimiento +
  motivo) con structured outputs, sobre `src/llm/`
- La keyword literal pasa a ser una pista de contexto para el modelo, no una
  garantía de relevancia
- Un solo modelo LLM para todo (el de análisis, Sonnet): desaparecen
  `CLASSIFIER_MODEL` y `OPENROUTER_CLASSIFIER_MODEL`, con aviso al arrancar
  si siguen en el `.env`
- Prompt con desambiguación geográfica (CABA vs. Ciudad de México y otros
  países; política nacional argentina)
- Motivo de la decisión en `matched_reason` y en el log de descartes
- Tests con captions de ejemplo (modelo stubeado), README, `CLAUDE.md`,
  `.env.example`

### Out of Scope

- X: las búsquedas por término siguen entrando directo (solo título y
  sentimiento)
- Reclasificar lo ya guardado: los posteos viejos quedan como están
- Frontend
- Apify: este cambio no toca el scraping

## Impact

- Costo LLM por posteo nuevo ≈ US$ 0,003 con Sonnet 5 (una llamada por
  posteo, la misma cantidad que hoy)
- `src/clasificarReclamo.js` y `src/importers/extraerDireccion.js` también
  pasan al modelo de análisis (pocas llamadas, en lotes)
