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
async function getVentas(token) {
  const fechaFinal = dayjs().format('YYYYMMDD');
  const fechaInicial = dayjs().subtract(89, 'day').format('YYYYMMDD');
  const body = {
    id_solicitud: 6254,
    service: 'BI215HGJY6CNS',
    appuser: 'habibbi01',
    pwd: 'I96SBG4G43KY56MS',
    company: 'habib',
    entity: 'G362SSDG003PRB',
    data: {
      usmng: 'MNGBI',
      emp: '101',
      tpumd: 1,
      fecha_inicial: fechaInicial,
      fecha_final: fechaFinal
    }
  };
  /*const fechaFinal = dayjs().format('YYYYMMDD');
  const fechaInicial = dayjs().subtract(89, 'day').format('YYYYMMDD');
  console.log(fechaFinal+" - "+fechaInicial);
  const body = {
    id_solicitud: 6255,
    service: 'BI226GSRGSRTT',
    appuser: 'habibbi01',
    pwd: 'I96SBG4G43KY56MS',
    company: 'habib',
    entity: 'G362SSDG003PRB',
    data: {
      usmng: 'MNGBI',
      emp: '101',
      sku: '*',
      dtbod: 1,
      bod:'*',
      suc:'*',
      cco:'*',
      tpumd: 1,
      fecha_inicial: fechaInicial,
      fecha_final: fechaFinal
    }
  };*/

  const response = await axios.post(
    'https://saaserpzn1a.qualitycolombia.com.co:58090/G4lj4BB6t1cW/saas/api/execute',
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    }
  );
  console.log(response)
  return response.data.data; // array de objetos
}

// Paso 3: Guardar en MySQL usando inserciones por lotes
async function saveRotacionesToDatabase(rotaciones) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  console.log(`[${new Date().toISOString()}] Limpiando tabla ventas...`);
  await conn.execute('DELETE FROM ventas');

  const insertQuery = `
    INSERT INTO ventas
    (sku, bod, rot30, rot60, rot90)
    VALUES ?
  `;

  const batchSize = 1000;
  for (let i = 0; i < rotaciones.length; i += batchSize) {
    const batch = rotaciones.slice(i, i + batchSize);
    const values = batch.map(r => [
      r.sku,
      r.bod,
      r.rot30,
      r.rot60,
      r.rot90
    ]);

    await conn.query(insertQuery, [values]);
  }

  await conn.end();
  console.log(`[${new Date().toISOString()}] Guardado exitoso de rotaciones`);
}

// Paso 4: Orquestar el proceso
async function syncVentas() {
  try {
    console.log(`[${new Date().toISOString()}] Obteniendo token...`);
    const token = await getToken();

    console.log(`[${new Date().toISOString()}] Consultando ventas...`);
    const ventas = await getVentas(token);

    console.log(`[${new Date().toISOString()}] Calculando rotación 30/60/90 días...`);
    const rotaciones = calcularRotaciones(ventas);

    console.log(`[${new Date().toISOString()}] Total registros: ${rotaciones.length}`);
    await saveRotacionesToDatabase(rotaciones);

  } catch (error) {
    console.error('Error:', error.message);
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

function calcularRotaciones(data) {
  const hoy = new Date();
  const dias30 = new Date(hoy); dias30.setDate(hoy.getDate() - 30);
  const dias60 = new Date(hoy); dias60.setDate(hoy.getDate() - 60);
  const dias90 = new Date(hoy); dias90.setDate(hoy.getDate() - 90);

  const rotaciones = {};

  for (const item of data) {
    const fecha = dayjs(item.fec, 'YYYYMMDD').toDate();
    const clave = `${item.sku}|${item.bod}`;

    if (!rotaciones[clave]) {
      rotaciones[clave] = {
        sku: item.sku,
        bod: item.bod,
        rot30: 0,
        rot60: 0,
        rot90: 0
      };
    }

    const cantidad = parseFloat(item.cant || 0);

    if (fecha >= dias90) {
      rotaciones[clave].rot90 += cantidad;
      if (fecha >= dias60) {
        rotaciones[clave].rot60 += cantidad;
        if (fecha >= dias30) {
          rotaciones[clave].rot30 += cantidad;
        }
      }
    }
  }

  return Object.values(rotaciones);
}

syncVentas();
// Ejecutar inmediatamente al iniciar
module.exports = { syncVentas };
