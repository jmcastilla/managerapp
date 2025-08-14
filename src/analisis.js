require('dotenv').config();
const mysql = require('mysql2/promise');
const cron = require('node-cron');

// 1. Cargar datos de inventario y ventas
async function cargarDatos() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  const [inventario] = await conn.query('SELECT sku, nombre, bod, stock FROM inventarios');
  const [ventas] = await conn.query('SELECT sku, bod, rot30, rot60, rot90, rotdia30, rotdia60, rotdia90 FROM ventas');

  await conn.end();

  return { inventario, ventas };
}

// 2. Analizar stock y rotaciones por SKU + bodega
function analizarFaltantesYAlertas(inventario, ventas) {
  const ventasMap = {};
  for (const v of ventas) {
    ventasMap[`${v.sku}|${v.bod}`] = v;
  }

  const resultados = [];

  for (const item of inventario) {
    const clave = `${item.sku}|${item.bod}`;
    const venta = ventasMap[clave];

    if (!venta) continue;

    const diasCobertura30 = venta.rotdia30 > 0 ? item.stock / venta.rotdia30 : null;
    const diasCobertura90 = venta.rotdia90 > 0 ? item.stock / venta.rotdia90 : null;

    const rotacionActiva = venta.rot30 > 0 || venta.rot60 > 0 || venta.rot90 > 0;

    let estado = 'OK';

    if (item.stock <= 0) {
      estado = rotacionActiva ? 'FALTANTE' : 'SIN MOVIMIENTO';
    } else if (diasCobertura30 !== null && diasCobertura30 <= 4) {
      estado = 'CRÍTICO';
    } else if (diasCobertura30 !== null && diasCobertura30 <= 7) {
      estado = 'BAJO STOCK';
    } else if (diasCobertura90 !== null && diasCobertura90 >= 90) {
      estado = 'SOBRESTOCK';
    }
    if(estado !== 'OK' && estado !== 'SOBRESTOCK' && estado !== 'SIN MOVIMIENTO'){
      resultados.push({
        sku: item.sku,
        nombre: item.nombre,
        bod: item.bod,
        stock: item.stock,
        rot30: venta.rot30,
        rot60: venta.rot60,
        rot90: venta.rot90,
        estado
      });
    }

  }

  return resultados;
}

// 3. Guardar alertas en base de datos
async function guardarAlertas(alertas) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });
  await conn.query('UPDATE alertas_stock SET es_actual = 0');

  const insertQuery = `
    INSERT INTO alertas_stock
    (sku, nombre, bod, stock, estado, fecha, rot30, rot60, rot90, es_actual)
    VALUES ?
  `;

  const ahora = new Date();

  const values = alertas.map(a => [
    a.sku,
    a.nombre,
    a.bod,
    a.stock,
    a.estado,
    ahora,
    a.rot30,
    a.rot60,
    a.rot90,
    1
  ]);

  await conn.query(insertQuery, [values]);
  await conn.end();

  console.log(`[${new Date().toISOString()}] Alertas guardadas correctamente: ${alertas.length} registros.`);
}

// 4. Ejecutar el análisis completo
async function ejecutarAnalisis() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando análisis de stock...`);
    const { inventario, ventas } = await cargarDatos();
    const alertas = analizarFaltantesYAlertas(inventario, ventas);
    await guardarAlertas(alertas);
  } catch (err) {
    console.error('Error en análisis de alertas:', err.message);
  }
}


// 6. Ejecutar inmediatamente al iniciar el script
ejecutarAnalisis();
