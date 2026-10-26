// ==========================================================================
// geo/geometria.js
// --------------------------------------------------------------------------
// Lo poco de geometría que necesitan los datasets del GCBA (fase H): leer un
// CSV con campos entre comillas (el de espacios verdes trae el polígono en
// WKT adentro de un campo), los polígonos WKT y GeoJSON, y el centroide de
// área de uno o varios polígonos (los agujeros restan). Sin dependencias:
// geopandas y shapely hacían esto en el proyecto original.
// ==========================================================================

/**
 * CSV con comillas dobles ("" adentro es una comilla), separado por comas,
 * con o sin BOM. Devuelve una lista de objetos por el encabezado.
 */
function leerCsv(texto) {
  const filas = [];
  let campo = '';
  let fila = [];
  let comillas = false;
  const s = String(texto || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (comillas) {
      if (c === '"' && s[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      fila.push(campo);
      campo = '';
      if (fila.length > 1 || fila[0] !== '') filas.push(fila);
      fila = [];
    } else campo += c;
  }
  if (campo !== '' || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  const [encabezado, ...datos] = filas;
  if (!encabezado) return [];
  return datos.map((f) => Object.fromEntries(encabezado.map((k, i) => [k.trim(), f[i] === undefined ? '' : f[i]])));
}

/**
 * POLYGON / MULTIPOLYGON en WKT → lista de polígonos, cada uno una lista de
 * anillos [[x, y], …] (el primero, el borde; los demás, agujeros).
 */
function poligonosWkt(wkt) {
  const t = String(wkt || '').trim();
  const multi = /^MULTIPOLYGON/i.test(t);
  if (!multi && !/^POLYGON/i.test(t)) return [];
  const cuerpo = t.replace(/^[A-Z ]+/i, '');
  const anillo = (txt) =>
    txt
      .split(',')
      .map((par) => par.trim().split(/\s+/).map(Number))
      .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const deUnPoligono = (txt) => [...txt.matchAll(/\(([^()]+)\)/g)].map((m) => anillo(m[1]));
  if (!multi) return [deUnPoligono(cuerpo)];
  // Cada polígono del multi está entre "((" y "))".
  return [...cuerpo.matchAll(/\(\s*(\([^()]+\)(?:\s*,\s*\([^()]+\))*)\s*\)/g)].map((m) => deUnPoligono(m[1]));
}

/** Polygon / MultiPolygon de GeoJSON → la misma forma que poligonosWkt. */
function poligonosGeojson(geometria) {
  if (!geometria) return [];
  if (geometria.type === 'Polygon') return [geometria.coordinates];
  if (geometria.type === 'MultiPolygon') return geometria.coordinates;
  return [];
}

// Área con signo y centroide de un anillo (fórmula del polígono).
function areaYCentro(anillo) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < anillo.length; i++) {
    const [x1, y1] = anillo[i];
    const [x2, y2] = anillo[(i + 1) % anillo.length];
    const cruz = x1 * y2 - x2 * y1;
    a += cruz;
    cx += (x1 + x2) * cruz;
    cy += (y1 + y2) * cruz;
  }
  a /= 2;
  if (a === 0) return { area: 0, x: anillo[0] ? anillo[0][0] : NaN, y: anillo[0] ? anillo[0][1] : NaN };
  return { area: a, x: cx / (6 * a), y: cy / (6 * a) };
}

/**
 * Centroide de área de varios polígonos juntos (los agujeros restan). Para
 * coordenadas en grados alcanza a la escala de una plaza o de una villa.
 * @returns {{ x: number, y: number, area: number } | null}
 */
function centroide(poligonos) {
  let total = 0;
  let sx = 0;
  let sy = 0;
  let respaldo = null;
  for (const poligono of poligonos) {
    poligono.forEach((anillo, i) => {
      if (!anillo || anillo.length < 3) return;
      const r = areaYCentro(anillo);
      if (!respaldo) respaldo = r;
      // El borde suma su área absoluta y los agujeros la restan, sin
      // depender del sentido en que vino dibujado cada anillo.
      const area = i === 0 ? Math.abs(r.area) : -Math.abs(r.area);
      total += area;
      sx += r.x * area;
      sy += r.y * area;
    });
  }
  if (total > 0) return { x: sx / total, y: sy / total, area: total };
  return respaldo && Number.isFinite(respaldo.x) ? { x: respaldo.x, y: respaldo.y, area: 0 } : null;
}

module.exports = { leerCsv, poligonosWkt, poligonosGeojson, centroide };
