require('dotenv').config();
const mysql = require('mysql2/promise');
const cron = require('node-cron');

// 1. Cargar datos necesarios
async function cargarDatos() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  const [rows] = await conn.query(`
    SELECT
      i.sku, i.bod, i.stock,
      COALESCE(v.rot30, 0) AS rot30,
      COALESCE(v.rot60, 0) AS rot60,
      COALESCE(v.rot90, 0) AS rot90,
      COALESCE(v.rotdia30, COALESCE(v.rot30,0)/30) AS rotdia30,
      COALESCE(v.rotdia90, COALESCE(v.rot90,0)/90) AS rotdia90,
      COALESCE(c.clasificacion, 'D') AS clasificacion
    FROM inventarios i
    LEFT JOIN ventas v ON i.sku = v.sku AND i.bod = v.bod
    LEFT JOIN clasificacion c ON i.sku = c.sku AND i.bod = c.bod
  `);

  await conn.end();
  return rows;
}

function calcularEstado({ stock, rot30, rot60, rot90, rotdia30, rotdia90 }) {
  const rotacionActiva = (rot30 > 0 || rot60 > 0 || rot90 > 0);

  const diasCobertura30 = rotdia30 > 0 ? stock / rotdia30 : null;
  const diasCobertura90 = rotdia90 > 0 ? stock / rotdia90 : null;

  if (stock <= 0) {
    return rotacionActiva ? 'FALTANTE' : 'SIN MOVIMIENTO';
  }
  if (diasCobertura30 !== null && diasCobertura30 <= 4) {
    return 'CRÍTICO';
  }
  if (diasCobertura30 !== null && diasCobertura30 <= 7) {
    return 'BAJO STOCK';
  }
  if (diasCobertura90 !== null && diasCobertura90 >= 90) {
    return 'SOBRESTOCK';
  }
  return 'OK';
}

// 2. Calcular sugeridos de compra
function calcularSugeridos(data) {
  return data.map(item => {
    let diasCobertura = 0;

    if (item.clasificacion === 'A') diasCobertura = 30;
    else if (item.clasificacion === 'B') diasCobertura = 20;
    else if (item.clasificacion === 'C') diasCobertura = 10;
    const rotpromdia = (item.rot30 / 30);
    const sugerido = (rotpromdia * diasCobertura) - item.stock;
    const sugeridoFinal = sugerido > 0 ? Math.ceil(sugerido) : 0;
    const estado = calcularEstado(item);
    return {
      sku: item.sku,
      bod: item.bod,
      stock: item.stock,
      rot30: item.rot30,
      clasificacion: item.clasificacion,
      diasCobertura: diasCobertura,
      sugerido: sugeridoFinal,
      estado: estado
    };
  }).filter(p => p.sugerido > 0); // Solo los que hay que pedir
}

// 3. Guardar sugeridos en base de datos
async function guardarSugeridos(sugeridos) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  // Limpia la tabla antes de insertar
  await conn.execute('DELETE FROM sugeridos_compra');

  const insertQuery = `
    INSERT INTO sugeridos_compra
    (sku, bod, stock, rot30, clasificacion, sugerido, diascobertura, estado)
    VALUES ?
  `;

  const ahora = new Date();
  const batchSize = 1000;

  for (let i = 0; i < sugeridos.length; i += batchSize) {
    const batch = sugeridos.slice(i, i + batchSize);
    const values = batch.map(p => [
      p.sku,
      p.bod,
      p.stock,
      p.rot30,
      p.clasificacion,
      p.sugerido,
      p.diasCobertura,
      p.estado
    ]);
    await conn.query(insertQuery, [values]);
  }

  await conn.end();
  console.log(`[${new Date().toISOString()}] Sugeridos guardados: ${sugeridos.length} registros.`);
}

// 4. Orquestar todo
async function ejecutarSugeridos() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando generación de sugeridos...`);
    const data = await cargarDatos();
    const sugeridos = calcularSugeridos(data);
    await guardarSugeridos(sugeridos);
  } catch (err) {
    console.error('Error generando sugeridos:', err.message);
  }
}


// 6. Ejecutar inmediatamente al iniciar
module.exports = { ejecutarSugeridos };
