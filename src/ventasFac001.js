require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');
const dayjs = require('dayjs');

// =======================
// 1) TOKEN
// =======================
async function getToken() {
  const response = await axios.post(
    process.env.LOGIN_URL,
    { username: process.env.LOGIN_USER, password: process.env.LOGIN_PASS },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const tokenText = response.data;
  const token =
    typeof tokenText === 'string' && tokenText.startsWith('Token')
      ? tokenText.split(' ').pop()
      : tokenText;

  return token;
}

// =======================
// 2) GET VENTAS (HOY-HOY SIEMPRE)
// =======================
async function getVenta(token) {
  const ayer = dayjs().subtract(1, 'day').format('YYYYMMDD');

  const body = {
    id_solicitud: 6255,
    service: 'BI231C4MLBRKF',
    appuser: process.env.APPUSER,
    pwd: process.env.APPUSER_PWD,
    company: process.env.COMPANY,
    entity: process.env.ENTITY,
    data: {
      usmng: 'MNGBI',
      emp: '101',
      sku: '*',
      dtbod: '1',
      bod: '*',
      suc: '*',
      cco: '*',
      tpumd: '1',
      fecha_inicial: ayer,
      fecha_final: ayer,
    },
  };

  const response = await axios.post(process.env.INVENTORY_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  const raw = response.data?.data || [];
  console.log(
    `[${new Date().toISOString()}] getVenta -> registros SIN filtrar: ${
      Array.isArray(raw) ? raw.length : 0
    }`
  );

  return Array.isArray(raw) ? raw : [];
}

// =======================
// Helpers
// =======================
function toIntOrZero(v) {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}
function isOnlyDigits(v) {
  return /^\d+$/.test(String(v ?? '').trim());
}
function toMysqlDatetime(v) {
  if (!v) return null;
  const d = dayjs(v);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss') : null;
}
function normalizeFecha(v) {
  const s = String(v ?? '').trim();
  const d = dayjs(s, ['YYYY-MM-DD', 'YYYYMMDD'], true);
  return d.isValid() ? d.format('YYYY-MM-DD') : null;
}

function mapVentaToDbRow(item) {
  const factura = `${item.documento ?? ''}${item.numero ?? ''}`.trim();

  // Si factura comienza con D => devolución
  const isDevolucion = /^D/i.test(factura);

  // medico con punto/no-numérico => 0 y "SIN DEFINIR"
  let codMedico = 0;
  let nomMedico = 'SIN DEFINIR';
  if (isOnlyDigits(item.medico)) {
    codMedico = toIntOrZero(item.medico);
    nomMedico =
      item.mednom && String(item.mednom).trim()
        ? String(item.mednom).trim()
        : 'SIN DEFINIR';
  }

  // cantidad/valor en negativo si es devolución
  const cantidad = toIntOrZero(item.cant1);
  const valor = toIntOrZero(item.valor);

  const cantidadFinal = isDevolucion ? -Math.abs(cantidad) : cantidad;
  const valorFinal = isDevolucion ? -Math.abs(valor) : valor;

  return [
    normalizeFecha(item.fecha), // fecha
    toIntOrZero(item.codpunto), // codpunto
    factura, // factura
    String(toIntOrZero(item.caja)), // caja (numérico en string)
    String(toIntOrZero(item.ccnit)), // doc_cliente (numérico en string)
    String(item.cliente ?? '').trim(), // cliente
    toIntOrZero(item.ven), // cod_vendedor
    String(item.vennom ?? '').trim(), // vendedor
    codMedico, // cod_medico
    nomMedico, // medico (nombre)
    String(item.sku ?? ''), // cod_producto
    String(item.descripcion ?? '').trim(), // producto
    cantidadFinal, // cantidad (negativa si devolución)
    String(item.und1 ?? '').trim(), // unidad
    valorFinal, // valor (negativo si devolución)
    toMysqlDatetime(item.fechora), // fechahora
    toIntOrZero(item.codlab), // cod_laboratorio
    String(item.laboratorio ?? '').trim(), // laboratorio
    String(item.fpago ?? '').trim(), // formapago
    String(item.email ?? '').trim(), // email
    String(item.telefono ?? '').trim(), // telefono
  ];
}

// =======================
// 3) Guardar HOY (y descartar codpunto=0)
// =======================
async function saveVentasToDatabase(items) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: 'manager2',
  });

  const insertQuery = `
    INSERT INTO ventas (
      fecha, codpunto, factura, caja, doc_cliente, cliente,
      cod_vendedor, vendedor, cod_medico, medico,
      cod_producto, producto, cantidad, unidad, valor, fechahora,
      cod_laboratorio, laboratorio, formapago, email, telefono
    ) VALUES ?
  `;

  // DESCARTAR codpunto=0 (y fechas inválidas)
  const filtradas = items.filter(
    (it) => toIntOrZero(it.codpunto) !== 0 && normalizeFecha(it.fecha) !== null
  );

  const batchSize = 1000;
  let inserted = 0;

  for (let i = 0; i < filtradas.length; i += batchSize) {
    const batch = filtradas.slice(i, i + batchSize);
    const values = batch.map(mapVentaToDbRow);

    if (values.length === 0) continue;

    await conn.query(insertQuery, [values]);
    inserted += values.length;
  }

  await conn.end();
  return { received: items.length, kept: filtradas.length, inserted };
}

// =======================
// 4) Orquestación (HOY)
// =======================
async function syncVentasHoy() {
  try {
    console.log(
      `[${new Date().toISOString()}] Iniciando sincronización de ventas (HOY)...`
    );
    const token = await getToken();

    const ventas = await getVenta(token);
    console.log(`[${new Date().toISOString()}] Ventas recibidas: ${ventas.length}`);

    const res = await saveVentasToDatabase(ventas);
    console.log(
      `[${new Date().toISOString()}] OK. Recibidas=${res.received} | Filtradas=${res.kept} | Insertadas=${res.inserted}`
    );
  } catch (err) {
    console.error(
      'Error durante sincronización:',
      err?.response?.data || err.message
    );
  }
}
module.exports = { syncVentasHoy, getToken, getVenta };
