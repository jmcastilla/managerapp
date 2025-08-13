require('dotenv').config();
const mysql = require('mysql2/promise');
const cron = require('node-cron');

// 1. Cargar ventas con rot90 desde inventarios y ventas
async function cargarVentas() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  const [ventas] = await conn.query(`
    SELECT i.sku, i.bod, COALESCE(v.rot90, 0) as rot90
    FROM inventarios i
    LEFT JOIN ventas v ON i.sku = v.sku AND i.bod = v.bod
  `);

  await conn.end();
  return ventas;
}

// 2. Clasificar por bodega
function clasificarProductosABC(ventas) {
  const agrupadoPorBodega = {};

  // Agrupar por bod
  for (const v of ventas) {
    if (!agrupadoPorBodega[v.bod]) {
      agrupadoPorBodega[v.bod] = [];
    }
    agrupadoPorBodega[v.bod].push({
      sku: v.sku,
      bod: v.bod,
      rot90: parseFloat(v.rot90 || 0)
    });
  }

  const resultadoFinal = [];

  for (const bod in agrupadoPorBodega) {
    const productos = agrupadoPorBodega[bod];

    const activos = productos.filter(p => p.rot90 > 0);
    activos.sort((a, b) => b.rot90 - a.rot90);

    const totalRotacion = activos.reduce((acc, p) => acc + p.rot90, 0);
    let acumulado = 0;

    const clasificados = activos.map(p => {
      acumulado += p.rot90;
      const porcentajeAcumulado = acumulado / totalRotacion;

      let clasificacion = 'C';
      if (porcentajeAcumulado <= 0.70) {
        clasificacion = 'A';
      } else if (porcentajeAcumulado <= 0.90) {
        clasificacion = 'B';
      }

      return {
        sku: p.sku,
        bod: p.bod,
        rot90: p.rot90,
        clasificacion
      };
    });

    // Productos sin rotación = D
    const sinMovimiento = productos
      .filter(p => p.rot90 === 0)
      .map(p => ({
        sku: p.sku,
        bod: p.bod,
        rot90: 0,
        clasificacion: 'D'
      }));

    resultadoFinal.push(...clasificados, ...sinMovimiento);
  }

  return resultadoFinal;
}

// 3. Guardar clasificación en base de datos
async function guardarClasificacionABC(clasificados) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  await conn.execute('DELETE FROM clasificacion');

  const insertQuery = `
    INSERT INTO clasificacion
    (sku, bod, rot90, clasificacion)
    VALUES ?
  `;

  const batchSize = 1000;
  for (let i = 0; i < clasificados.length; i += batchSize) {
    const batch = clasificados.slice(i, i + batchSize);
    const values = batch.map(p => [
      p.sku,
      p.bod,
      p.rot90,
      p.clasificacion
    ]);
    await conn.query(insertQuery, [values]);
  }

  await conn.end();
  console.log(`[${new Date().toISOString()}] Clasificación ABC guardada: ${clasificados.length} registros.`);
}

// 4. Ejecutar todo
async function ejecutarClasificacionABC() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando clasificación ABC por bodega...`);
    const ventas = await cargarVentas();
    const clasificados = clasificarProductosABC(ventas);
    await guardarClasificacionABC(clasificados);
  } catch (err) {
    console.error('Error al clasificar productos ABC:', err.message);
  }
}

// 5. Ejecutar cada 4 horas con node-cron
cron.schedule('0 */4 * * *', () => {
  console.log(`[${new Date().toISOString()}] (CRON) Ejecutando clasificación ABC cada 4 horas...`);
  ejecutarClasificacionABC();
});

// 6. Ejecutar inmediatamente
ejecutarClasificacionABC();
