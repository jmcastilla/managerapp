// src/coopidrogas-cron.js
require('dotenv').config();

const dns = require('dns');
const { Resolver } = require('dns').promises;

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const { CookieJar } = require('tough-cookie');
const mysql = require('mysql2/promise');
const cron = require('node-cron');

// --- Forzar IPv4 sin usar httpsAgent (compatible con axios-cookiejar-support) ---
if (typeof dns.setDefaultResultOrder === 'function') {
  // Node >= 17
  dns.setDefaultResultOrder('ipv4first');
} else {
  // Fallback para Node < 17
  const _lookup = dns.lookup;
  dns.lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    // fuerza IPv4
    return _lookup(hostname, { ...options, family: 4, all: false }, cb);
  };
}

process.on('unhandledRejection', (e) => {
  console.error('[coopidrogas] UnhandledRejection:', e && (e.stack || e.message || e));
});
process.on('uncaughtException', (e) => {
  console.error('[coopidrogas] UncaughtException:', e && (e.stack || e.message || e));
});

async function syncCoopidrogas() {
  const { wrapper } = await import('axios-cookiejar-support'); // ESM only aquí

  const BASE = 'https://sipasociados.coopidrogas.com.co';
  const TABLE_NAME = process.env.CDP_TABLE || 'coopidrogas';
  const BATCH = 1000;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- Cookie jar
  const jar = new CookieJar();

  // ---- Cliente axios SIN httpsAgent (clave para compatibilidad)
  const clientCore = axios.create({
    baseURL: BASE,
    withCredentials: true,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 20000,
    maxRedirects: 0,  // el login espera 302
    proxy: false,     // ignora HTTP(S)_PROXY del entorno
    jar,              // jar presente desde la creación
  });

  // Retries exponenciales ante timeouts/5xx/sin respuesta
  axiosRetry(clientCore, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (err) =>
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNABORTED' ||
      !err.response || (err.response && err.response.status >= 500),
  });

  // Habilitar soporte de cookies
  const client = wrapper(clientCore);
  client.defaults.jar = jar;
  client.defaults.withCredentials = true;

  // ---------- Helpers de parseo ----------
  function findArrays(node, path = '$', acc = []) {
    if (!node) return acc;
    if (Array.isArray(node)) { acc.push({ path, arr: node }); return acc; }
    if (typeof node === 'object')
      for (const k of Object.keys(node)) findArrays(node[k], `${path}.${k}`, acc);
    return acc;
  }

  function detectBestArrayPath(payload) {
    if (Array.isArray(payload?.rows)) return '$.rows';
    const arrays = findArrays(payload);
    arrays.sort((a, b) => {
      const aObj = a.arr.length && typeof a.arr[0] === 'object' && !Array.isArray(a.arr[0]);
      const bObj = b.arr.length && typeof b.arr[0] === 'object' && !Array.isArray(b.arr[0]);
      const aHasCell = !!(a.arr[0] && typeof a.arr[0] === 'object' && 'cell' in a.arr[0]);
      const bHasCell = !!(b.arr[0] && typeof b.arr[0] === 'object' && 'cell' in b.arr[0]);
      if (aObj !== bObj) return bObj - aObj;
      if (aHasCell !== bHasCell) return bHasCell - aHasCell;
      return b.arr.length - a.arr.length;
    });
    return arrays.length ? arrays[0].path : null;
  }

  function getByPath(obj, path) {
    if (!path || path === '$') return obj;
    const parts = path.split('.').slice(1);
    let cur = obj;
    for (const p of parts) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[p]; }
    return cur;
  }

  function mapCellRows(rows, payload) {
    const cols =
      (Array.isArray(payload?.colModel) && payload.colModel.map(c => c?.name)) ||
      (Array.isArray(payload?.columns) && payload.columns) ||
      (Array.isArray(payload?.colNames) && payload.colNames) ||
      null;
    return rows.map(r => {
      if (!Array.isArray(r?.cell)) return r;
      const out = {};
      r.cell.forEach((v, i) => { out[cols?.[i] || `col${i}`] = v; });
      if (r?.id !== undefined) out.id = r.id;
      return out;
    });
  }

  function extractProducts(payload, arrayPath) {
    let arr = arrayPath ? getByPath(payload, arrayPath) : null;
    if (!arr && Array.isArray(payload?.rows)) arr = payload.rows;
    if (!Array.isArray(arr)) return [];
    const first = arr[0];
    if (first && typeof first === 'object' && 'cell' in first) return mapCellRows(arr, payload);
    return arr;
  }

  function toNumber(v) {
    if (v === null || v === undefined) return 0;
    const s = String(v).replace(/[^\d,.-]/g, '');
    const normalized = s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }

  function normalizeItem(item) {
    const SKU = String(item.material ?? '').trim();
    const DESCRIPCION = String(item.producto ?? '').trim();
    const EAN = String(item.codigoBarras ?? '').trim();
    const PROVEEDOR = String(item.proveedor ?? '').trim();
    const CORRIENTE = toNumber(item.corriente ?? 0);
    const REAL = Math.round(toNumber(item.real ?? 0));
    const BONIFICACION = toNumber(item.bonificacion ?? 0);
    const DISPONIBLE = toNumber(item.disp ?? 0);
    const MAXIMO = toNumber(item.maximoXPedido ?? 0);

    if (!SKU || !DESCRIPCION) return null;
    return { SKU, DESCRIPCION, EAN, PROVEEDOR, CORRIENTE, REAL, BONIFICACION, DISPONIBLE, MAXIMO };
  }

  /*async function saveBatch(conn, rows) {
    if (!rows.length) return 0;
    const sql = `
      INSERT INTO \`${TABLE_NAME}\`
        (\`sku\`, \`descripcion\`, \`ean\`, \`proveedor\`, \`corriente\`, \`precioreal\`, \`bonificacion\`, \`disponible\`, \`maximo\`)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        \`descripcion\` = VALUES(\`descripcion\`),
        \`ean\` = VALUES(\`ean\`),
        \`proveedor\` = VALUES(\`proveedor\`),
        \`corriente\` = VALUES(\`corriente\`),
        \`precioreal\` = VALUES(\`precioreal\`),
        \`bonificacion\` = VALUES(\`bonificacion\`),
        \`disponible\` = VALUES(\`disponible\`),
        \`maximo\` = VALUES(\`maximo\`),
        \`actualizacion\` = NOW()
    `;
    const values = rows.map(r => [
      r.SKU, r.DESCRIPCION, r.EAN, r.PROVEEDOR,
      r.CORRIENTE, r.REAL, r.BONIFICACION, r.DISPONIBLE, r.MAXIMO
    ]);
    await conn.query(sql, [values]);
    return rows.length;
  }*/

  async function saveBatch(conn, rows) {
  if (!rows.length) return 0;
  const sql = `
    INSERT INTO \`${TABLE_NAME}\`
      (\`sku\`, \`descripcion\`, \`ean\`, \`proveedor\`, \`corriente\`,
       \`precioreal\`, \`bonificacion\`, \`disponible\`, \`maximo\`,
       \`realant\`, \`disponibleant\`)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      /* --- 1) Captura el valor anterior si hay cambio,
               o sincroniza si quedó desfasado (orden L→R importa) --- */
      \`realant\` = CASE
        WHEN NOT (VALUES(\`precioreal\`) <=> \`precioreal\`) THEN \`precioreal\`   -- cambió: guarda el precio viejo
        WHEN \`realant\` <> \`precioreal\`                     THEN \`precioreal\`   -- no cambió: iguala si estaba distinto
        ELSE \`realant\`
      END,
      \`disponibleant\` = CASE
        WHEN NOT (VALUES(\`disponible\`) <=> \`disponible\`) THEN \`disponible\`
        WHEN \`disponibleant\` <> \`disponible\`             THEN \`disponible\`
        ELSE \`disponibleant\`
      END,

      /* --- 2) Ahora aplica los valores nuevos --- */
      \`descripcion\`   = VALUES(\`descripcion\`),
      \`ean\`           = VALUES(\`ean\`),
      \`proveedor\`     = VALUES(\`proveedor\`),
      \`corriente\`     = VALUES(\`corriente\`),
      \`precioreal\`    = VALUES(\`precioreal\`),
      \`bonificacion\`  = VALUES(\`bonificacion\`),
      \`disponible\`    = VALUES(\`disponible\`),
      \`maximo\`        = VALUES(\`maximo\`),
      \`actualizacion\` = NOW()
  `;
  const values = rows.map(r => [
    r.SKU, r.DESCRIPCION, r.EAN, r.PROVEEDOR,
    r.CORRIENTE, r.REAL, r.BONIFICACION, r.DISPONIBLE, r.MAXIMO,
    // INSERT inicial: "anteriores" = valores actuales (para que no queden desfasados en la 2ª corrida)
    r.REAL, r.DISPONIBLE
  ]);
  await conn.query(sql, [values]);
  return rows.length;
}



  // ---------- Flujo principal ----------
  try {
    console.log('='.repeat(60));
    console.log(`[coopidrogas] Iniciando sincronización @ ${new Date().toISOString()}`);
    console.log('[coopidrogas] ENV PROXIES:', {
      HTTP_PROXY: process.env.HTTP_PROXY || null,
      HTTPS_PROXY: process.env.HTTPS_PROXY || null,
      ALL_PROXY: process.env.ALL_PROXY || null,
      NO_PROXY: process.env.NO_PROXY || null,
    });

    // DNS info (A / AAAA) para diagnosticar
    try {
      const r = new Resolver();
      const A = await r.resolve4('sipasociados.coopidrogas.com.co');
      console.log('[coopidrogas] DNS A records:', A);
      try {
        const AAAA = await r.resolve6('sipasociados.coopidrogas.com.co');
        console.log('[coopidrogas] DNS AAAA records:', AAAA);
      } catch { console.log('[coopidrogas] DNS AAAA records: none'); }
    } catch (e) {
      console.log('[coopidrogas] DNS resolve error:', e && (e.message || e));
    }

    // Smoke test (HEAD /) — distingue problema de red vs app
    await client.request({
      method: 'HEAD',
      url: '/',
      validateStatus: s => s >= 200 && s < 500,
    });

    // Login (espera 302)
    await client.post(
      '/drogueria/login_check',
      new URLSearchParams({
        _username: process.env.CDP_USER,
        _password: process.env.CDP_PASS,
        seccion: '',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: s => s === 302,
      }
    );
    console.log('[coopidrogas] Login OK');

    // Paginación
    const rowsPerPage = 15000;
    let page = 1;
    const all = [];

    const baseParams = `sord[]=ASC&sidx[]=producto&rows=${rowsPerPage}`;
    const firstUrl = `/drogueria/productosJson/1?${baseParams}&page=${page}`;

    const r1 = await client.get(firstUrl, {
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${BASE}/drogueria/catalogo/1`,
      },
      validateStatus: s => s >= 200 && s < 400,
    });

    const p1 = typeof r1.data === 'string' ? JSON.parse(r1.data) : r1.data;
    const arrayPath = detectBestArrayPath(p1);
    const items1 = extractProducts(p1, arrayPath);
    items1.forEach(it => { const n = normalizeItem(it); if (n) all.push(n); });

    const totalPages = Number(p1?.total) || Infinity;
    console.log(`[coopidrogas] Página 1 OK, items: ${items1.length}, totalPages: ${Number.isFinite(totalPages) ? totalPages : 'desconocido'}, arrayPath: ${arrayPath || '(auto)'}`);

    // Siguientes páginas
    page = 2;
    while (true) {
      if (page > 1 && Number.isFinite(totalPages) && page > totalPages) break;

      const url = `/drogueria/productosJson/1?${baseParams}&page=${page}`;

      // pequeño delay con jitter para no parecer scraper agresivo
      await sleep(300 + Math.floor(Math.random() * 200));

      const rp = await client.get(url, {
        headers: {
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE}/drogueria/catalogo/1`,
        },
        validateStatus: s => s >= 200 && s < 400,
      });

      const payload = typeof rp.data === 'string' ? JSON.parse(rp.data) : rp.data;
      const items = extractProducts(payload, arrayPath);
      if (!items.length) {
        console.log(`[coopidrogas] Página ${page} sin items, deteniendo.`);
        break;
      }
      items.forEach(it => { const n = normalizeItem(it); if (n) all.push(n); });
      console.log(`[coopidrogas] Página ${page} OK, items: ${items.length}, acumulado: ${all.length}`);

      if (payload?.page && payload?.total && Number(page) >= Number(payload.total)) break;
      page++;
    }

    console.log(`[coopidrogas] Total normalizados: ${all.length}`);

    // DB
    const conn = await mysql.createConnection({
      host: (process.env.DB_HOST || '').trim(),
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      charset: 'utf8mb4',
      connectTimeout: 15000,
    });

    let saved = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      await saveBatch(conn, chunk);
      saved += chunk.length;
      console.log(`[coopidrogas] Upsert batch -> ${saved}/${all.length}`);
    }
    await conn.end();
    console.log(`[coopidrogas] Sincronización finalizada @ ${new Date().toISOString()}`);
  } catch (e) {
    const code = e && (e.code || (e.response && e.response.status));
    console.error('[coopidrogas] Error:', code || e.message || e);
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      console.error('[coopidrogas] Sugerencias: verificar salida TCP 443, proxy forzado, IPv6 roto, o allowlist del proveedor.');
    }
  }
}

// Ejecuta una vez al inicio
syncCoopidrogas()
  .catch(e => console.error('[coopidrogas] Error en ejecución inicial:', e && (e.stack || e.message || e)));

// Minutos 20 y 50 de cada hora
cron.schedule('20,50 * * * *', syncCoopidrogas);
