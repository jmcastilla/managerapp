// src/enviar-consulta-cada-2h-html.js
require('dotenv').config();
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const dayjs = require('dayjs');

// =============== CONFIG ===============
const QUERY_SQL = process.env.QUERY_SQL ||
  `SELECT idalerta, sku, descripcion, disponible, disponibleant, precioreal, realant, estadoinventario, estadoprecio, tipo, fecha
   FROM ${process.env.DB_TABLE}
   WHERE enviado = 0
   ORDER BY idalerta`;

const MAX_ROWS_PER_EMAIL = Number(process.env.MAX_ROWS_PER_EMAIL || 2000); // divide en varios correos si hay más filas

// =============== DB ===================
async function getConn() {
  return mysql.createConnection({
    host: (process.env.DB_HOST || '').trim(),
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    connectTimeout: 15000,
  });
}

async function fetchRows(conn) {
  const [rows] = await conn.query(QUERY_SQL);
  return rows;
}

async function markSent(conn, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const sql = `
    UPDATE ${process.env.DB_TABLE}
    SET enviado = 1
    WHERE idalerta IN (${placeholders})
  `;
  console.log(sql);
  await conn.execute(sql, ids);
}

// =============== EMAIL =================
function createTransporter() {
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : (port === 465);

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,          // p.ej. smtp.gmail.com
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tableHtml(rows) {
  if (!rows.length) return '<p>No hay registros.</p>';
  const cols = Object.keys(rows[0]);

  const columnas = [
    { key: 'idalerta', label: 'ID Alerta' },
    { key: 'sku', label: 'SKU' },
    { key: 'descripcion', label: 'Descripción' },
    { key: 'disponible', label: 'Disponible' },
    { key: 'disponibleant', label: 'Disponible Anterior' },
    { key: 'precioreal', label: 'Precio Real' },
    { key: 'realant', label: 'Precio Real Anterior' },
    { key: 'estadoinventario', label: 'Estado Inventario' },
    { key: 'estadoprecio', label: 'Estado Precio' },
    { key: 'tipo', label: 'Tipo' },
    { key: 'fecha', label: 'Fecha' },
  ];

  const head = columnas.map(c =>
    `<th style="padding:8px;border-bottom:1px solid #ddd;text-align:left;background:#f8f9fa">${escapeHtml(c.label)}</th>`
  ).join('');

  const body = rows.map(r => {
    const tds = columnas.map(c =>
      `<td style="padding:6px;border-bottom:1px solid #eee;vertical-align:top">${escapeHtml(r[c.key])}</td>`
    ).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  return `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
    <p>Fecha de generación: <strong>${dayjs().format('YYYY-MM-DD HH:mm:ss')}</strong></p>
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;min-width:600px">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

function chunkArray(arr, size) {
  if (!size || size <= 0) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sendHtmlEmails(rows) {
  const transporter = createTransporter();
  const toList = (process.env.MAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!toList.length) throw new Error('Configura MAIL_TO con al menos un destinatario');

  const chunks = chunkArray(rows, MAX_ROWS_PER_EMAIL);
  const sentInfos = [];

  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i];
    const subjectBase = process.env.MAIL_SUBJECT || 'Reporte alertas Coopidrogas';
    const subject = chunks.length > 1
      ? `${subjectBase} (parte ${i + 1}/${chunks.length}) - ${part.length} filas`
      : `${subjectBase} - ${rows.length} filas`;

    const html = `
      <h2 style="font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0 0 10px">${subject}</h2>
      ${tableHtml(part)}
    `;

    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM, // "Nombre <tu@correo>"
      to: toList,
      subject,
      html,
    });
    sentInfos.push(info);
  }
  return sentInfos;
}

// =============== ORQUESTA ===============
async function runOnce() {
  const conn = await getConn();
  try {
    const rows = await fetchRows(conn);
    console.log(`[job] ${new Date().toISOString()} - filas: ${rows.length}`);

    if (!rows.length) return;

    await sendHtmlEmails(rows);
    console.log('[job] correos enviados ✔');

    // marcar como enviado
    const ids = rows.map(r => r.idalerta).filter(v => v !== undefined && v !== null);
    await markSent(conn, ids);
    console.log(`[job] marcado enviado=1: ${ids.length}`);
  } catch (e) {
    console.error('[job] Error:', e?.message || e);
  } finally {
    await conn.end();
  }
}


// Ejecuta al iniciar
module.exports = { runOnce };
