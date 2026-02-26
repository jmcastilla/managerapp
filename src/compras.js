// comprasSync.js
require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');
const dayjs = require('dayjs');
// const cron = require('node-cron'); // (opcional) si quieres programarlo

// -------------------------
// Paso 1: Obtener token
// -------------------------
async function getToken() {
  const response = await axios.post(
    process.env.LOGIN_URL,
    {
      username: process.env.LOGIN_USER,
      password: process.env.LOGIN_PASS
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const tokenText = response.data;
  const token = typeof tokenText === 'string' && tokenText.startsWith('Token')
    ? tokenText.split(' ').pop()
    : tokenText;

  return token;
}

// Util: YYYYMMDD -> YYYY-MM-DD
function yyyymmddToMysqlDate(yyyymmdd) {
  const s = String(yyyymmdd || '');
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// -------------------------
// Paso 2: Llamar servicio compras (BI2294TNFP9T6)
// -------------------------
async function getCompras(token, { fecha_inicial, fecha_final }) {
  const body = {
    id_solicitud: 6254,
    service: "BI2294TNFP9T6",
    appuser: process.env.APPUSER,
    pwd: process.env.APPUSER_PWD,
    company: process.env.COMPANY,
    entity: process.env.ENTITY,
    data: {
      usmng: "MNGBI",
      emp: "101",
      fecha_inicial: String(fecha_inicial), // "20240701"
      fecha_final: String(fecha_final)      // "20240701"
    }
  };

  const response = await axios.post(process.env.INVENTORY_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });

  // La respuesta viene como: { error:0, msg:"", data:[...] }
  const payload = response.data || {};
  if (Number(payload.error) !== 0) {
    throw new Error(payload.msg || 'Error desconocido en servicio compras');
  }

  return payload.data || [];
}

// -------------------------
// Paso 3: Guardar en MySQL (tabla compras)
// Mapeo JSON -> tabla:
// fecha     <- item.fec (YYYYMMDD) -> YYYY-MM-DD
// factura   <- `${item.tp}-${item.num}` (ej: FC02-113644297)
// proveedor <- item.cliente
// sku       <- item.sku
// cantidad  <- item.cant
// bodega    <- item.bod
// umd       <- item.umd
// valor     <- item.vtatotal  (si prefieres sin IVA, cambia a vtasiniva o vtasinimpt)
// -------------------------
async function saveComprasToDatabase(items, { fecha_inicial, fecha_final }) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: "manager2"
  });

  const fechaIniMysql = yyyymmddToMysqlDate(fecha_inicial);
  const fechaFinMysql = yyyymmddToMysqlDate(fecha_final);

  try {
    await conn.beginTransaction();

    // Limpia solo el rango que vas a recargar (evita duplicados)
    console.log(`[${new Date().toISOString()}] Limpiando compras ${fecha_inicial}..${fecha_final}...`);
    const batchSize = 1000;
    const insertQuery = `
      INSERT INTO compras (fecha, factura, proveedor, sku, cantidad, bodega, umd, valor)
      VALUES ?
    `;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      const values = batch.map(item => {
        const fecha = yyyymmddToMysqlDate(item.fec) || null;
        const factura = `${item.tp ?? ''}-${item.num ?? ''}`.replace(/^-|-$/g, '') || String(item.num ?? '');
        const proveedor = String(item.cliente ?? '');
        const sku = String(item.sku ?? '');
        const cantidad = Number(item.cant ?? 0);     // tu tabla es INT, MySQL truncará decimales si hay
        const bodega = String(item.bod ?? '');
        const umd = String(item.umd ?? '');
        const valor = Number(item.vtatotal ?? 0);    // tu tabla es INT, MySQL truncará decimales si hay

        return [fecha, factura, proveedor, sku, cantidad, bodega, umd, valor];
      });

      await conn.query(insertQuery, [values]);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

// -------------------------
// Paso 4: Orquestador 18-12-2024
// -------------------------
async function syncCompras(options = {}) {
  try {

    // Por defecto: HOY (puedes cambiarlo a ayer si quieres)
    const ayer = dayjs().subtract(1, 'day').format('YYYYMMDD');

    console.log(`[${new Date().toISOString()}] Iniciando sync compras (${fecha_inicial}..${fecha_final})...`);

    const token = await getToken();

    console.log(`→ Obteniendo compras...`);
    const compras = await getCompras(token, { ayer, ayer });

    console.log(`→ Guardando en DB...`);
    await saveComprasToDatabase(compras, { ayer, ayer });

    console.log(`[${new Date().toISOString()}] OK. Total items: ${compras.length}`);
    return { ok: true, total: compras.length };
  } catch (err) {
    console.error('Error durante syncCompras:', err.message);
    return { ok: false, error: err.message };
  }
}

// (Opcional) programar diario a la 1:10 AM
// cron.schedule('10 1 * * *', () => syncCompras());
module.exports = { syncCompras };
