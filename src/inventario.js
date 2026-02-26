require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const dayjs = require('dayjs');

// SKUs a excluir (exactos)
const SKUS_EXCLUIDOS = new Set([
  '616253',
  '616252',
  '616251',
  '616241',
  '616223'
]);

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

// Util: parse de upd a datetime MySQL
function parseUpdToDatetime(rawUpd) {
  if (!rawUpd) return null;
  const clean = String(rawUpd).replace(/\s+/g, ' ').trim(); // "20250727 08:23:28"
  const [datePart, timePart] = clean.split(' ');

  if (!datePart || !timePart || datePart.length < 8) return null;

  return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)} ${timePart}`;
}

// Filtro de SKUs (omitir exactos + todos los que empiecen por S)
function debeExcluirSku(sku) {
  const s = String(sku ?? '').trim();
  if (!s) return true; // si no trae sku, lo excluimos
  if (SKUS_EXCLUIDOS.has(s)) return true;
  if (s.toUpperCase().startsWith('S')) return true;
  return false;
}

// Paso 3: Guardar en MySQL usando inserciones por lotes (omitiendo SKUs)
async function saveToDatabase(items) {
  // Filtrar antes de guardar
  const itemsFiltrados = items.filter(item => !debeExcluirSku(item.sku));

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  });

  try {
    console.log(`[${new Date().toISOString()}] Limpiando Base de datos...`);
    await conn.execute('DELETE FROM inventarios');

    const batchSize = 1000;
    const insertQuery = `
      INSERT INTO inventarios (sku, nombre, bod, stock, upd)
      VALUES ?
    `;

    for (let i = 0; i < itemsFiltrados.length; i += batchSize) {
      const batch = itemsFiltrados.slice(i, i + batchSize);

      const values = batch.map(item => [
        String(item.sku ?? '').trim(),
        item.nombre ?? '',
        item.bod ?? '',
        Number(item.stock ?? 0),
        parseUpdToDatetime(item.upd)
      ]);

      await conn.query(insertQuery, [values]);
    }

    console.log(`[${new Date().toISOString()}] Guardado OK. Total guardados: ${itemsFiltrados.length} (excluidos: ${items.length - itemsFiltrados.length})`);
  } finally {
    await conn.end();
  }
}

// (Opcional) Unificar bodegas
function unificarBodegas(inventario) {
  const agrupado = {};

  for (const item of inventario) {
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
        stock: Number(item.stock || 0),
        upd: item.upd
      };
    } else {
      agrupado[clave].stock += Number(item.stock || 0);
    }
  }

  return Object.values(agrupado);
}

// Paso 4: Orquestar el proceso
async function syncInventario() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando sincronización...`);
    const token = await getToken();

    const bodegas = ['01P', '02P', '03P', '03R', '01U', '01T', '01C'];
    const inventarioTotal = [];

    for (const bodega of bodegas) {
      console.log(`→ Obteniendo inventario de bodega ${bodega}...`);
      const inventarioBodega = await getInventarioPorBodega(token, bodega);
      inventarioTotal.push(...inventarioBodega);
    }

    // Si quieres unificar 03P y 03R, descomenta:
    // const inventarioFinal = unificarBodegas(inventarioTotal);
    // await saveToDatabase(inventarioFinal);

    await saveToDatabase(inventarioTotal);

    console.log(`[${new Date().toISOString()}] Sincronización exitosa. Total items recibidos: ${inventarioTotal.length}`);
  } catch (err) {
    console.error('Error durante sincronización:', err.message);
  }
}

// Ejecutar inmediatamente al iniciar

module.exports = { syncInventario };
