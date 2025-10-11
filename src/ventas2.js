require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');
const dayjs = require('dayjs');

// Paso 1: Obtener token (igual que antes)
async function getToken() {
  const response = await axios.post(
    process.env.LOGIN_URL,
    { username: process.env.LOGIN_USER, password: process.env.LOGIN_PASS },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const tokenText = response.data;
  return tokenText.startsWith('Token')
    ? tokenText.split(' ').pop()
    : tokenText;
}

// Paso 2: Consumir el endpoint
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
      fecha_inicial: fechaInicial,
      fecha_final: fechaFinal
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

// Helper: normalizar fecha fec
function parseFec(fecRaw) {
  // Si viene como "YYYYMMDD", convertir a "YYYY-MM-DD"
  if (typeof fecRaw === 'string' && /^\d{8}$/.test(fecRaw)) {
    return dayjs(fecRaw, 'YYYYMMDD').format('YYYY-MM-DD');
  }
  return null;
}

// Paso 3: Guardar cada registro en tabla_ventas
async function saveVentasToDatabase(ventas) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  console.log(`[${new Date().toISOString()}] Limpiando tabla_ventas...`);
  await conn.execute('DELETE FROM tabla_ventas');

  const insertQuery = `
    INSERT INTO tabla_ventas
    (factura, fk_cliente, sku, cco, cant, vtatotal, vtasiniva, ven, fec, tipo)
    VALUES ?
  `;

  const values = ventas.map(v => [
    `${v.tp || ''}${v.numero ? '-' + v.numero : ''}` || null,
    v.fk_cliente || null,
    v.sku || null,
    v.cco || null,
    v.cant || 0,
    v.vtatotal || 0,
    v.vtasiniva || 0,
    v.ven || 0,
    parseFec(v.fec),
    v.tipo || null
  ]);

  const batchSize = 1000;
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    await conn.query(insertQuery, [batch]);
  }

  await conn.end();
  console.log(`[${new Date().toISOString()}] Guardado exitoso de ${ventas.length} registros`);
}

// Paso 4: Orquestar
async function syncVentasRaw() {
  try {
    console.log(`[${new Date().toISOString()}] Obteniendo token...`);
    const token = await getToken();

    const hoy = dayjs();
    const fechaInicial = hoy.subtract(29, 'day').format('YYYYMMDD');
    const fechaFinal = hoy.format('YYYYMMDD');

    console.log(`[${new Date().toISOString()}] Consultando ventas (${fechaInicial} a ${fechaFinal})...`);
    const ventas = await getVentasRango(token, fechaInicial, fechaFinal);

    console.log(`[${new Date().toISOString()}] Total recibido: ${ventas.length}`);
    await saveVentasToDatabase(ventas);

  } catch (error) {
    console.error('Error:', error?.response?.data || error?.message);
  }
}

module.exports = { syncVentasRaw };
