require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const dayjs = require('dayjs');

// Paso 1: Obtener el token
async function getToken() {
  const response = await axios.post(
    process.env.LOGIN_URL,
    {
      username: process.env.LOGIN_USER,
      password: process.env.LOGIN_PASS
    },
    {
      headers: { 'Content-Type': 'application/json' }
    }
  );

  const tokenText = response.data;
  const token = tokenText.startsWith('Token')
    ? tokenText.split(' ').pop()
    : tokenText;

  return token;
}

// Paso 2: Llamar al servicio para una bodega específica
async function getInventarioPorBodega(token, bodega) {
  const body = {
    id_solicitud: 6254,
    service: "BI216CELM7S43",
    appuser: process.env.APPUSER,
    pwd: process.env.APPUSER_PWD,
    company: process.env.COMPANY,
    entity: process.env.ENTITY,
    data: {
      usmng: "MNGBI",
      emp: "101",
      sku: "*",
      bod: bodega,
      tpumd: "1",
      existencia: "e",
      igual: "1",
      fecha_corte: "20100101 16:40:00"
    }
  };

  const response = await axios.post(process.env.INVENTORY_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });
  return response.data.data || []; // array de objetos
}

// Paso 3: Guardar en MySQL usando inserciones por lotes
async function saveToDatabase(items) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: "agenteia"
  });

  console.log(`[${new Date().toISOString()}] Limpiando Base de datos...`);
  await conn.execute('DELETE FROM inventarios where idinventario>0');

  const batchSize = 1000;
  const insertQuery = `
    INSERT INTO inventarios (sku, bod, stock)
    VALUES ?
  `;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const values = batch.map(item => [
      item.sku,
      item.bod,
      parseFloat(item.stock || 0),
    ]);

    await conn.query(insertQuery, [values]);
  }

  await conn.end();
}

// Paso 4: Orquestar el proceso
async function syncInventario() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando sincronización...`);
    const token = await getToken();

    const bodegas = ['01P', '02P', '03P', '03R'];
    const inventarioTotal = [];

    for (const bodega of bodegas) {
      console.log(`→ Obteniendo inventario de bodega ${bodega}...`);
      const inventarioBodega = await getInventarioPorBodega(token, bodega);
      inventarioTotal.push(...inventarioBodega);
    }

    // Unificamos 03P y 03R como "03" y sumamos sus stocks
    //const inventarioUnificado = unificarBodegas(inventarioTotal);

    await saveToDatabase(inventarioTotal);

    console.log(`[${new Date().toISOString()}] Sincronización exitosa. Total items: ${inventarioTotal.length}`);
  } catch (err) {
    console.error('Error durante sincronización:', err.message);
  }
}

function parseUpdToDatetime(rawUpd) {
  // Quita espacios extra si los hay
  const clean = rawUpd.replace(/\s+/g, ' ').trim(); // "20250727 08:23:28"
  const [datePart, timePart] = clean.split(' ');

  if (!datePart || !timePart) return null;

  const formatted = `${datePart.slice(0,4)}-${datePart.slice(4,6)}-${datePart.slice(6,8)} ${timePart}`;
  return formatted; // YYYY-MM-DD HH:mm:ss
}

function unificarBodegas(inventario) {
  const agrupado = {};

  for (const item of inventario) {
    // Unificamos 03P y 03R como "03"
    let bodega = item.bod;
    if (bodega === '03P' || bodega === '03R') {
      bodega = '03A';
    }

    const clave = `${item.sku}|${item.nombre}|${bodega}`;

    if (!agrupado[clave]) {
      agrupado[clave] = {
        sku: item.sku,
        nombre: item.nombre,
        bod: bodega,
        stock: parseFloat(item.stock || 0),
        upd: item.upd
      };
    } else {
      agrupado[clave].stock += parseFloat(item.stock || 0);
    }
  }

  return Object.values(agrupado);
}
module.exports = { syncInventario };
