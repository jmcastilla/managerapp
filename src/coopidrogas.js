// src/coopidrogas-cron.js
require('dotenv').config();
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const mysql = require('mysql2/promise');
const cron = require('node-cron');

async function syncCoopidrogas() {
  const { wrapper } = await import('axios-cookiejar-support');

  const BASE = 'https://sipasociados.coopidrogas.com.co';
  const TABLE_NAME = process.env.CDP_TABLE || 'coopidrogas';
  const BATCH = 1000;

  const jar = new CookieJar();
  const client = wrapper(axios.create({
    baseURL: BASE,
    withCredentials: true,
    jar,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  }));

  async function login() {
    await client.post(
      '/drogueria/login_check',
      new URLSearchParams({
        _username: process.env.CDP_USER,   // pon en .env
        _password: process.env.CDP_PASS,   // pon en .env
        seccion: '',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 0,
        validateStatus: s => s === 302,
      }
    );
  }

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
    const REAL = toNumber(item.real ?? 0);
    const BONIFICACION = toNumber(item.bonificacion ?? 0);
    const DISPONIBLE = toNumber(item.disp ?? 0);
    const MAXIMO = toNumber(item.maximoXPedido ?? 0);

    if (!SKU || !DESCRIPCION) return null;
    return { SKU, DESCRIPCION, EAN, PROVEEDOR, CORRIENTE, REAL, BONIFICACION, DISPONIBLE, MAXIMO };
  }

  async function saveBatch(conn, rows) {
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
        \`maximo\` = VALUES(\`maximo\`)
    `;
    const values = rows.map(r => [
      r.SKU, r.DESCRIPCION, r.EAN, r.PROVEEDOR,
      r.CORRIENTE, r.REAL, r.BONIFICACION, r.DISPONIBLE, r.MAXIMO
    ]);
    await conn.query(sql, [values]);
    return rows.length;
  }

  try {
    console.log(`[coopidrogas] Iniciando sincronización...`);
    await login();

    const rowsPerPage = 200;
    let page = 1;
    const all = [];

    const firstUrl = `/drogueria/productosJson/1?sord[]=ASC&sidx[]=producto&rows=${rowsPerPage}&page=${page}`;
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
    page = 2;
    while (true) {
      if (page > 1 && Number.isFinite(totalPages) && page > totalPages) break;
      const url = `/drogueria/productosJson/1?sord[]=ASC&sidx[]=producto&rows=${rowsPerPage}&page=${page}`;
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
      if (!items.length) break;
      items.forEach(it => { const n = normalizeItem(it); if (n) all.push(n); });
      if (payload?.page && payload?.total && Number(page) >= Number(payload.total)) break;
      page++;
    }

    console.log(`[coopidrogas] Total normalizados: ${all.length}`);

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
    console.log(`[coopidrogas] Sincronización finalizada`);
  } catch (e) {
    console.error('[coopidrogas] Error:', e?.response?.status || e.message || e);
  }
}
syncCoopidrogas();

cron.schedule('20/50 * * * *', syncCoopidrogas);
