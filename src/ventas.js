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

// Paso 2: Llamar al servicio para un rango específico (<= 30 días)
async function getVentasRango(token, fechaInicial, fechaFinal) {
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
      fecha_inicial: fechaInicial, // YYYYMMDD
      fecha_final: fechaFinal      // YYYYMMDD
    }
  };

  const response = await axios.post(
    'https://saaserpzn1a.qualitycolombia.com.co:58090/G4lj4BB6t1cW/saas/api/execute',
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      timeout: 120000
    }
  );

  return response?.data?.data || [];
}

// Helper: construir tres ventanas de 30 días (no superpuestas)
function buildWindows90Days(today = dayjs()) {
  // Rango 1: 60–89 días atrás
  const w1Start = today.subtract(89, 'day').format('YYYYMMDD');
  const w1End   = today.subtract(60, 'day').format('YYYYMMDD');

  // Rango 2: 30–59 días atrás
  const w2Start = today.subtract(59, 'day').format('YYYYMMDD');
  const w2End   = today.subtract(30, 'day').format('YYYYMMDD');

  // Rango 3: 0–29 días atrás
  const w3Start = today.subtract(29, 'day').format('YYYYMMDD');
  const w3End   = today.format('YYYYMMDD');

  return [
    { start: w1Start, end: w1End },
    { start: w2Start, end: w2End },
    { start: w3Start, end: w3End }
  ];
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

// Paso 4: Orquestar el proceso (3 llamadas de 30 días)
async function syncVentas() {
  try {
    console.log(`[${new Date().toISOString()}] Obteniendo token...`);
    const token = await getToken();

    console.log(`[${new Date().toISOString()}] Construyendo ventanas de 30 días...`);
    const windows = buildWindows90Days(dayjs());

    let ventasAcumuladas = [];
    for (const [idx, w] of windows.entries()) {
      console.log(
        `[${new Date().toISOString()}] Consultando ventas ventana ${idx + 1} (${w.start} a ${w.end})...`
      );
      const parcial = await getVentasRango(token, w.start, w.end);
      ventasAcumuladas = ventasAcumuladas.concat(parcial);
      console.log(
        `[${new Date().toISOString()}] Ventana ${idx + 1}: ${parcial.length} registros`
      );
    }

    console.log(`[${new Date().toISOString()}] Total bruto 90 días: ${ventasAcumuladas.length}`);

    console.log(`[${new Date().toISOString()}] Calculando rotación 30/60/90 días...`);
    const rotaciones = calcularRotaciones(ventasAcumuladas);

    console.log(`[${new Date().toISOString()}] Total combinaciones SKU|BOD: ${rotaciones.length}`);
    await saveRotacionesToDatabase(rotaciones);

  } catch (error) {
    // A veces error.response?.data trae más detalle
    const detail = error?.response?.data || error?.message;
    console.error('Error:', detail);
  }
}

// (Opcional) Si tu backend entrega "fec" como "YYYYMMDD HH:mm:ss" y necesitas normalizar
function parseUpdToDatetime(rawUpd) {
  const clean = rawUpd.replace(/\s+/g, ' ').trim();
  const [datePart, timePart] = clean.split(' ');
  if (!datePart || !timePart) return null;
  const formatted = `${datePart.slice(0,4)}-${datePart.slice(4,6)}-${datePart.slice(6,8)} ${timePart}`;
  return formatted; // YYYY-MM-DD HH:mm:ss
}

// Calcula rotaciones a partir del arreglo consolidado
function calcularRotaciones(data) {
  const hoy = new Date();
  const dias30 = new Date(hoy); dias30.setDate(hoy.getDate() - 30);
  const dias60 = new Date(hoy); dias60.setDate(hoy.getDate() - 60);
  const dias90 = new Date(hoy); dias90.setDate(hoy.getDate() - 90);

  const rotaciones = {};

  for (const item of data) {
    // "fec" debe venir como YYYYMMDD (string) o número
    const fecha = dayjs(String(item.fec), 'YYYYMMDD').toDate();
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


module.exports = { syncVentas };
