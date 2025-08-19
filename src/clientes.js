// src/clientes.js
require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const dayjs = require('dayjs');

/* =========================
 * Paso 1: Obtener token
 * ========================= */
async function getToken() {
  const response = await axios.post(
    process.env.LOGIN_URL,
    { username: process.env.LOGIN_USER, password: process.env.LOGIN_PASS },
    { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
  );

  const tokenText = response.data;
  const token = typeof tokenText === 'string' && tokenText.startsWith('Token')
    ? tokenText.split(' ').pop()
    : tokenText;

  if (!token) throw new Error('No se obtuvo token de autenticación');
  return token;
}

/* =========================
 * Util: fecha_corte = hoy con (ahora - 6 min) -> "YYYYMMDD HH:mm:ss"
 * ========================= */
function buildFechaCorte(now = dayjs()) {
  const t = now.subtract(10, 'minute');
  return `${t.format('YYYYMMDD')} ${t.format('HH:mm:ss')}`;
}

/* =========================
 * Paso 2: Llamar servicio de clientes
 * ========================= */
async function getClientes(token) {
  const body = {
    id_solicitud: 6254,
    service: 'BI2034OLD65RE',
    appuser: 'habibbi01',
    pwd: 'I96SBG4G43KY56MS',
    company: 'habib',
    entity: 'G362SSDG003PRB',
    data: {
      usrmng: 'MNGBI',
      fecha_corte:buildFechaCorte()
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
      timeout: 120000,
      validateStatus: s => s >= 200 && s < 500
    }
  );

  const payload = response.data;
  if (payload?.error === 0 && payload?.msg === 'NoData') return [];
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;

  throw new Error(`Formato de respuesta no reconocido: ${JSON.stringify(payload).slice(0, 400)}`);
}

/* =========================
 * Normalización de campos para la tabla `clientes`
 * ========================= */
function normalizeCliente(raw) {
  const nit = String(
    raw?.ccnit ?? ''
  ).trim();

  const nombre = String(
    raw?.nombre ?? ''
  ).trim();

  const telefono = (String(raw?.telf1 ?? '').trim() || null);
  const direccion = (String(raw?.direccion ?? '').trim() || null);
  const email = (String(raw?.email ?? '').trim() || null);

  if (!nit || !nombre) return null;
  return { nit, nombre, telefono, direccion, email };
}

/* =========================
 * Paso 3: Guardar en MySQL (batches de 1000) con upsert por NIT
 * ========================= */
async function saveClientesToDatabase(clientes) {
  if (!clientes.length) {
    console.log(`[${new Date().toISOString()}] No hay clientes que guardar.`);
    return;
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4'
  });

  // Asegura UNIQUE KEY en `nit` en tu tabla `clientes`
  // ALTER TABLE `clientes` ADD UNIQUE KEY `uq_nit` (`nit`);

  const insertQuery = `
    INSERT INTO \`clientes\` (\`nit\`, \`nombre\`, \`telefono\`, \`direccion\`, \`email\`)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      \`nombre\` = VALUES(\`nombre\`),
      \`telefono\` = VALUES(\`telefono\`),
      \`direccion\` = VALUES(\`direccion\`),
      \`email\` = VALUES(\`email\`)
  `;

  const batchSize = 1000;
  let saved = 0;

  for (let i = 0; i < clientes.length; i += batchSize) {
    const batch = clientes.slice(i, i + batchSize);
    const values = batch.map(c => [c.nit, c.nombre, c.telefono, c.direccion, c.email]);
    await conn.query(insertQuery, [values]);
    saved += batch.length;
    console.log(`[${new Date().toISOString()}] Clientes upsert: ${saved}/${clientes.length}`);
  }

  await conn.end();
  console.log(`[${new Date().toISOString()}] Guardado exitoso de clientes`);
}

/* =========================
 * Paso 4: Orquestación
 * ========================= */
async function syncClientes() {
  try {
    console.log(`[${new Date().toISOString()}] Obteniendo token...`);
    const token = await getToken();

    console.log(`[${new Date().toISOString()}] Consultando clientes...`);
    const crudos = await getClientes(token);
    console.log(`[${new Date().toISOString()}] Clientes recibidos: ${crudos.length}`);

    const normalizados = [];
    for (const r of crudos) {
      const n = normalizeCliente(r);
      if (n) normalizados.push(n);
    }
    console.log(`[${new Date().toISOString()}] Clientes normalizados: ${normalizados.length}`);

    await saveClientesToDatabase(normalizados);
  } catch (error) {
    const detail = error?.response?.data || error?.message || error;
    console.error(`[${new Date().toISOString()}] Error en syncClientes:`, detail);
  }
}


module.exports = { syncClientes };
