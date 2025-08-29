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
async function getproductos(token) {
  const body = {
    id_solicitud: 6254,
    service: "BI202G42S6RG1",
    appuser: process.env.APPUSER,
    pwd: process.env.APPUSER_PWD,
    company: process.env.COMPANY,
    entity: process.env.ENTITY,
    data: {
      usmng: "MNGBI",
      fecha_corte: "19000101 11:10:30"
    }
  };

  const response = await axios.post(process.env.INVENTORY_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });
  console.log(response.data)
  return response.data.data || []; // array de objetos
}

// Paso 3: Guardar en MySQL usando inserciones por lotes
async function saveToDatabase(items) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  console.log(`[${new Date().toISOString()}] Limpiando Base de datos...`);
  await conn.execute('DELETE FROM productos');

  const batchSize = 1000;
  const insertQuery = `
    INSERT INTO productos (sku, nombre, proveedor, linea)
    VALUES ?
  `;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const values = batch.map(item => [
      item.sku,
      item.nombre,
      item.proveedor,
      item.linea
    ]);

    await conn.query(insertQuery, [values]);
  }

  await conn.end();
}

// Paso 4: Orquestar el proceso
async function syncProductos() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando sincronización...`);
    const token = await getToken();


    console.log(`→ Obteniendo productos...`);
    const maestro = await getproductos(token);


    // Unificamos 03P y 03R como "03" y sumamos sus stocks
    //const inventarioUnificado = unificarBodegas(inventarioTotal);

    await saveToDatabase(maestro);

    console.log(`[${new Date().toISOString()}] Sincronización exitosa. Total items: ${maestro.length}`);
  } catch (err) {
    console.error('Error durante sincronización:', err.message);
  }
}

// Ejecutar inmediatamente al iniciar
module.exports = { syncProductos };
