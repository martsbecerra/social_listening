// ==========================================================================
// importers/fechas.js
// --------------------------------------------------------------------------
// Parseo de la columna de fecha de un archivo a importar. Los archivos reales
// mezclan formatos: el histórico de X trae 2.965 filas con el mes suelto
// ("ABRIL") y 417 con fecha y hora completas ("29-Jul-2026 01:15PM").
//
// Un mes suelto NO es una fecha: se guarda el día 1 para poder ordenar y
// filtrar, pero marcado con precisión 'mes'. Así el filtro por rango del mapa
// no miente diciendo que un reclamo es del 1 de abril cuando lo único que se
// sabe es que fue en abril.
// ==========================================================================

const MESES_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

const MESES_EN = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** "29-Jul-2026 01:15PM" y variantes con guion, barra o espacio. */
const REGEX_COMPLETA =
  /^(\d{1,2})[-/\s]([A-Za-z]{3,10})[-/\s](\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;

/** ISO o algo que Date entienda directo ("2026-07-29T13:15:00Z"). */
const REGEX_ISO = /^\d{4}-\d{2}-\d{2}([T\s]|$)/;

function aIso(anio, mes, dia, hora = 0, min = 0, seg = 0) {
  const d = new Date(Date.UTC(anio, mes - 1, dia, hora, min, seg));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {unknown} raw valor crudo de la celda
 * @param {{ anioPorDefecto?: number }} [opts] año a asumir cuando sólo hay mes
 * @returns {{ fecha: string, precision: 'exacta'|'mes' } | null}
 */
function parsearFecha(raw, { anioPorDefecto = new Date().getUTCFullYear() } = {}) {
  if (raw == null || raw === '' || raw === 'NULL') return null;

  // Excel puede entregar la celda ya como Date.
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { fecha: raw.toISOString(), precision: 'exacta' };
  }

  const s = String(raw).trim();
  if (!s) return null;

  // --- Fecha (y hora) completa ---
  const m = s.match(REGEX_COMPLETA);
  if (m) {
    const dia = Number(m[1]);
    const mesNombre = fold(m[2]);
    const anio = Number(m[3]);
    const mes = MESES_EN[mesNombre.slice(0, 3)] || MESES_ES[mesNombre] || null;
    if (mes) {
      let hora = m[4] ? Number(m[4]) : 0;
      const min = m[5] ? Number(m[5]) : 0;
      const seg = m[6] ? Number(m[6]) : 0;
      const ampm = m[7] ? m[7].toLowerCase() : null;
      // 12AM es medianoche y 12PM es mediodía: el módulo 12 va antes de sumar.
      if (ampm === 'pm' && hora < 12) hora += 12;
      if (ampm === 'am' && hora === 12) hora = 0;
      const iso = aIso(anio, mes, dia, hora, min, seg);
      if (iso) return { fecha: iso, precision: 'exacta' };
    }
  }

  if (REGEX_ISO.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return { fecha: d.toISOString(), precision: 'exacta' };
  }

  // --- Sólo el mes ("ABRIL", "abril 2026") ---
  const soloMes = fold(s).match(/^([a-z]+)(?:\s+(\d{4}))?$/);
  if (soloMes) {
    const mes = MESES_ES[soloMes[1]] || MESES_EN[soloMes[1].slice(0, 3)] || null;
    if (mes) {
      const anio = soloMes[2] ? Number(soloMes[2]) : anioPorDefecto;
      const iso = aIso(anio, mes, 1);
      if (iso) return { fecha: iso, precision: 'mes' };
    }
  }

  return null;
}

module.exports = { parsearFecha };
