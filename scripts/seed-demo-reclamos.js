'use strict';

// 50 reclamos de demo para el mapa (geo_status=ok, coordenadas WGS84).
// Los escribe en Instagram y en X para que ambas solapas tengan pines.
// Revertir: node scripts/seed-demo-reclamos.js --revert

const db = require('../src/db');
const { listCategorias, subcategoriasDe } = require('../src/categoriasConfig');

const ORIGEN = 'seed-demo-mapa';
const ESTADOS = ['Pendiente', 'En tratamiento', 'Resuelto', 'Desestimado'];

// lng = x, lat = y (igual que claimsMap.js y territorios.js).
const PUNTOS = [
  { calle: 'Av. Santa Fe', altura: 3253, lng: -58.4112, lat: -34.5881, barrio: 'Palermo', comuna: 14 },
  { calle: 'Av. Córdoba', altura: 4100, lng: -58.4215, lat: -34.5982, barrio: 'Palermo', comuna: 14 },
  { calle: 'Plaza Serrano', altura: null, lng: -58.4308, lat: -34.5889, barrio: 'Palermo', comuna: 14, lugar: true },
  { calle: 'Av. Callao', altura: 1200, lng: -58.3926, lat: -34.5954, barrio: 'Recoleta', comuna: 2 },
  { calle: 'Av. Las Heras', altura: 2100, lng: -58.3968, lat: -34.5884, barrio: 'Recoleta', comuna: 2 },
  { calle: 'Av. Cabildo', altura: 2500, lng: -58.4568, lat: -34.5624, barrio: 'Belgrano', comuna: 13 },
  { calle: 'Juramento', altura: 1800, lng: -58.4492, lat: -34.5648, barrio: 'Belgrano', comuna: 13 },
  { calle: 'Av. Rivadavia', altura: 4800, lng: -58.4372, lat: -34.6186, barrio: 'Caballito', comuna: 6 },
  { calle: 'Parque Centenario', altura: null, lng: -58.4356, lat: -34.6064, barrio: 'Caballito', comuna: 6, lugar: true },
  { calle: 'Av. Corrientes', altura: 4100, lng: -58.4218, lat: -34.6039, barrio: 'Almagro', comuna: 5 },
  { calle: 'Av. Medrano', altura: 700, lng: -58.4210, lat: -34.6068, barrio: 'Almagro', comuna: 5 },
  { calle: 'Av. Warnes', altura: 1400, lng: -58.4421, lat: -34.5987, barrio: 'Villa Crespo', comuna: 15 },
  { calle: 'Av. Juan B. Justo', altura: 2700, lng: -58.4386, lat: -34.5995, barrio: 'Villa Crespo', comuna: 15 },
  { calle: 'Av. Rivadavia', altura: 6800, lng: -58.4638, lat: -34.6284, barrio: 'Flores', comuna: 7 },
  { calle: 'Plaza Flores', altura: null, lng: -58.4632, lat: -34.6289, barrio: 'Flores', comuna: 7, lugar: true },
  { calle: 'Av. Asamblea', altura: 1200, lng: -58.4384, lat: -34.6352, barrio: 'Parque Chacabuco', comuna: 7 },
  { calle: 'Defensa', altura: 800, lng: -58.3718, lat: -34.6206, barrio: 'San Telmo', comuna: 1 },
  { calle: 'Av. Independencia', altura: 400, lng: -58.3704, lat: -34.6178, barrio: 'San Telmo', comuna: 1 },
  { calle: 'Caminito', altura: null, lng: -58.3629, lat: -34.6388, barrio: 'La Boca', comuna: 4, lugar: true },
  { calle: 'Av. Almirante Brown', altura: 700, lng: -58.3618, lat: -34.6336, barrio: 'La Boca', comuna: 4 },
  { calle: 'Juana Manso', altura: 1500, lng: -58.3634, lat: -34.6102, barrio: 'Puerto Madero', comuna: 1 },
  { calle: 'Av. del Libertador', altura: 300, lng: -58.3746, lat: -34.5898, barrio: 'Retiro', comuna: 1 },
  { calle: 'Av. de Mayo', altura: 800, lng: -58.3786, lat: -34.6089, barrio: 'Monserrat', comuna: 1 },
  { calle: 'Av. 9 de Julio', altura: 1000, lng: -58.3816, lat: -34.6037, barrio: 'San Nicolás', comuna: 1 },
  { calle: 'Av. Corrientes', altura: 1800, lng: -58.3904, lat: -34.6040, barrio: 'San Nicolás', comuna: 1 },
  { calle: 'Av. Pueyrredón', altura: 600, lng: -58.4056, lat: -34.6092, barrio: 'Balvanera', comuna: 3 },
  { calle: 'Av. Rivadavia', altura: 2800, lng: -58.4058, lat: -34.6101, barrio: 'Balvanera', comuna: 3 },
  { calle: 'Av. Boedo', altura: 800, lng: -58.4168, lat: -34.6254, barrio: 'Boedo', comuna: 5 },
  { calle: 'Av. Caseros', altura: 2500, lng: -58.4008, lat: -34.6372, barrio: 'Parque Patricios', comuna: 4 },
  { calle: 'Av. Montes de Oca', altura: 900, lng: -58.3768, lat: -34.6402, barrio: 'Barracas', comuna: 4 },
  { calle: 'Av. Sáenz', altura: 800, lng: -58.4182, lat: -34.6508, barrio: 'Nueva Pompeya', comuna: 4 },
  { calle: 'Av. Triunvirato', altura: 4200, lng: -58.4842, lat: -34.5736, barrio: 'Villa Urquiza', comuna: 12 },
  { calle: 'Av. Mosconi', altura: 2800, lng: -58.5034, lat: -34.5822, barrio: 'Villa Pueyrredón', comuna: 12 },
  { calle: 'Av. Balbín', altura: 3200, lng: -58.4868, lat: -34.5548, barrio: 'Saavedra', comuna: 12 },
  { calle: 'Av. Cabildo', altura: 4700, lng: -58.4624, lat: -34.5486, barrio: 'Núñez', comuna: 13 },
  { calle: 'Av. Álvarez Thomas', altura: 1400, lng: -58.4502, lat: -34.5748, barrio: 'Colegiales', comuna: 13 },
  { calle: 'Av. Corrientes', altura: 6200, lng: -58.4546, lat: -34.5884, barrio: 'Chacarita', comuna: 15 },
  { calle: 'Av. San Martín', altura: 2400, lng: -58.4682, lat: -34.5976, barrio: 'Paternal', comuna: 15 },
  { calle: 'Av. de los Incas', altura: 4400, lng: -58.4688, lat: -34.5804, barrio: 'Villa Ortúzar', comuna: 15 },
  { calle: 'Av. San Martín', altura: 4800, lng: -58.4884, lat: -34.6052, barrio: 'Villa del Parque', comuna: 11 },
  { calle: 'Av. Francisco Beiró', altura: 4600, lng: -58.5126, lat: -34.6004, barrio: 'Villa Devoto', comuna: 11 },
  { calle: 'Av. Juan B. Justo', altura: 6400, lng: -58.4802, lat: -34.6164, barrio: 'Villa Santa Rita', comuna: 11 },
  { calle: 'Av. Rivadavia', altura: 8600, lng: -58.4836, lat: -34.6302, barrio: 'Floresta', comuna: 10 },
  { calle: 'Av. Rivadavia', altura: 10200, lng: -58.5014, lat: -34.6364, barrio: 'Villa Luro', comuna: 10 },
  { calle: 'Av. Rivadavia', altura: 11600, lng: -58.5192, lat: -34.6398, barrio: 'Liniers', comuna: 9 },
  { calle: 'Av. Alberdi', altura: 4700, lng: -58.5026, lat: -34.6578, barrio: 'Mataderos', comuna: 9 },
  { calle: 'Av. Directorio', altura: 4300, lng: -58.4784, lat: -34.6486, barrio: 'Parque Avellaneda', comuna: 9 },
  { calle: 'Av. Riestra', altura: 5400, lng: -58.4722, lat: -34.6754, barrio: 'Villa Lugano', comuna: 8 },
  { calle: 'Av. Escalada', altura: 3200, lng: -58.4456, lat: -34.6652, barrio: 'Villa Soldati', comuna: 8 },
  { calle: 'Av. Entre Ríos', altura: 1500, lng: -58.3914, lat: -34.6272, barrio: 'Constitución', comuna: 1 },
];

const TEXTOS = [
  'La vereda está rota y no se puede caminar con el cochecito.',
  'Hace semanas que no pasan a levantar la basura, los contenedores desbordan.',
  'Plaza sin mantenimiento, pasto alto y juegos rotos.',
  'Hay un auto abandonado hace meses frente a mi casa.',
  'Corte de luz de nuevo en todo el cuadra, es el tercero de la semana.',
  'Piden más presencia policial a la noche, ya no se puede volver tarde.',
  'Los trapitos se pelean por los lugares y no hay control.',
  'El subte llegó con 20 minutos de demora y el andén estaba sucio.',
  'Semáforo en rojo permanente, el cruce es un caos.',
  'Cortaron la avenida por un piquete y nadie avisa por dónde desviarse.',
  'No hay turnos en el hospital hasta octubre.',
  'La escuela tiene goteo en tres aulas desde el temporal.',
  'Personas en situación de calle durmiendo en la entrada del edificio.',
  'El contenedor de reciclables nunca se vacía y tira olor.',
  'Bache profundo, ya se rompieron dos cubiertas este mes.',
  'Locales ocupando toda la vereda con mesas, hay que ir por la calle.',
  'Roedores a la vista apenas baja el sol.',
  'Falta un semáforo en la esquina de la escuela.',
  'El SAME tardó casi una hora anoche.',
  'Usurpación en la casa de al lado, nadie hace nada.',
  'Cortaron mal los árboles y dejaron las ramas tiradas.',
  'No anda el alumbrado de la cuadra entera.',
  'Queja por el aumento del ABL, no se entiende el cálculo.',
  'Barrera del tren trabada, la fila llega hasta Rivadavia.',
  'Manteros tapando la peatonal, no se puede pasar.',
  'Obras paradas hace meses, el pozo está sin señalizar.',
  'Contenedores quemados y todavía no los reponen.',
  'Inundación en la esquina cada vez que llueve un poco.',
  'Falta rampa en la esquina, es imposible cruzar en silla de ruedas.',
  'Música a todo volumen de un evento hasta las 3 de la mañana.',
  'No hay barrendero por esta zona hace semanas.',
  'Autos mal estacionados sobre la bicisenda.',
  'El hospital está sucio y faltan insumos básicos.',
  'Pedido de desmalezamiento en el predio abandonado.',
  'Fallas de luz durante el partido, se cortó todo el barrio.',
  'Parada de colectivo que no existe más y la app sigue mandando ahí.',
  'Venta de droga a la vista en la plaza, de día.',
  'Reclamo por el estado de la estación, techo goteando.',
  'No hay contenedores diferenciados en ninguna cuadra.',
  'Queja por el precio del subte y el servicio cada vez peor.',
  'Edificio tomado frente al colegio, los chicos tienen miedo.',
  'Vereda nueva que se levantó a los dos meses.',
  'Ruidos de obra de madrugada, no respetan el horario.',
  'Falta mantenimiento del puente, hay hierros a la vista.',
  'Consulta por licencia de conducir, el turno lo dan para 2027.',
  'El SAME no entra porque hay autos tapando la calle.',
  'Plaza con jeringas y vidrio tirado al lado de los juegos.',
  'Corte de agua no anunciado desde las 7 de la mañana.',
  'Piden recuperar la esquina de los manteros.',
  'El trámite digital no funciona y en la sede no atienden.',
];

function direccionDe(p) {
  if (p.lugar) return p.calle;
  return `${p.calle} ${p.altura}`;
}

function fechaHace(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  d.setHours(10 + (dias % 8), (dias * 7) % 60, 0, 0);
  return d.toISOString();
}

function armarFilas() {
  const categorias = listCategorias();
  const filas = [];
  const now = new Date().toISOString();

  for (const plataforma of ['instagram', 'x']) {
    PUNTOS.forEach((p, i) => {
      const categoria = categorias[i % categorias.length];
      const subs = subcategoriasDe(categoria);
      const subcategoria = subs[i % Math.max(subs.length, 1)] || '';
      const dir = direccionDe(p);
      const n = String(i + 1).padStart(2, '0');
      const id = `demo:${plataforma}:${n}`;
      const esX = plataforma === 'x';
      filas.push({
        id,
        comentarioId: id,
        plataforma,
        postUrl: esX ? `https://x.com/vecino${n}/status/1000000000${n}` : `https://www.instagram.com/p/DEMO${n}/`,
        commentUrl: esX ? `https://x.com/vecino${n}/status/1000000000${n}` : null,
        autor: `vecino${n}`,
        fecha: fechaHace(1 + (i % 45)),
        detectedAt: now,
        textoOriginal: TEXTOS[i],
        categoria,
        subcategoria,
        precisionFecha: 'exacta',
        importOrigen: ORIGEN,
        direccionDetectada: dir,
        direccionNormalizada: dir,
        calle: p.calle,
        altura: p.altura,
        cruce: null,
        x: p.lng,
        y: p.lat,
        comuna: p.comuna,
        barrio: p.barrio,
        precision: p.lugar ? 'aproximada' : 'exacta',
        geoStatus: 'ok',
        estado: ESTADOS[i % ESTADOS.length],
      });
    });
  }
  return filas;
}

function revertir() {
  const n = db.deleteReclamosPorOrigen(ORIGEN);
  console.log(`Se borraron ${n} reclamos de demo (${ORIGEN}).`);
}

function seed() {
  revertir();
  const filas = armarFilas();
  for (const fila of filas) db.upsertReclamo(fila);
  console.log(`Listos ${filas.length} reclamos de demo: ${PUNTOS.length} en Instagram y ${PUNTOS.length} en X.`);
  console.log('Para sacarlos: node scripts/seed-demo-reclamos.js --revert');
}

if (process.argv.includes('--revert') && !process.argv.includes('--seed')) {
  revertir();
} else {
  seed();
}
