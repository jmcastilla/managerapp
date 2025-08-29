// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors({ origin: "*" }));// permite tu front
app.use(express.json());

// Pool de MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME, // manager
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
});

// -----------------------------
// Helpers de autenticación
// -----------------------------
function signToken(user) {
  // user: { id, name, email }
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

async function findUserByEmail(email) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT idusuarios, name, email, passhash FROM usuarios WHERE email = ? LIMIT 1',
      [email]
    );
    return rows[0] || null;
  } finally {
    conn.release();
  }
}

async function createUser({ name, email, password }) {
  const passhash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  try {
    const [res] = await conn.query(
      'INSERT INTO usuarios (name, email, passhash) VALUES (?, ?, ?)',
      [name, email, passhash]
    );
    return { id: res.insertId, name, email };
  } finally {
    conn.release();
  }
}

function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  console.log(auth);
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'No token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, name, email }
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token inválido' });
  }
}

// -----------------------------
// Auth endpoints (JWT)
// -----------------------------

// Registro
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ ok: false, error: 'Faltan campos' });
    }

    const existing = await findUserByEmail(String(email).toLowerCase());
    if (existing) return res.status(409).json({ ok: false, error: 'Email ya registrado' });

    const user = await createUser({ name, email: String(email).toLowerCase(), password });
    const token = signToken(user);
    return res.status(201).json({ ok: true, token, user });
  } catch (e) {
    console.error('[auth] register error:', e);
    return res.status(500).json({ ok: false, error: 'Error en registro' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    }

    const user = await findUserByEmail(String(email).toLowerCase());
    if (!user) return res.status(401).json({ ok: false, error: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, user.passhash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Credenciales inválidas' });

    const { id, name } = user;
    const token = signToken({ id, name, email: user.email });
    return res.json({ ok: true, token, user: { id, name, email: user.email } });
  } catch (e) {
    console.error('[auth] login error:', e);
    return res.status(500).json({ ok: false, error: 'Error en login' });
  }
});

// Perfil (protegida)
app.get('/api/auth/me', verifyToken, async (req, res) => {
  return res.json({ ok: true, user: req.user });
});

// -----------------------------
// Endpoints existentes (datos)
// -----------------------------

// Coopidrogas
app.get('/api/coopidrogas', verifyToken, async (req, res) => {

  const selectSql = `
    SELECT sku, descripcion, ean, proveedor, corriente, precioreal, bonificacion, disponible, maximo
    FROM coopidrogas
    ORDER BY sku
    LIMIT 1000000
  `;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql);
      res.json({ ok: true, rows });
    } finally { conn.release(); }
  } catch (e) {
    console.error('[api] Error /api/coopidrogas:', e);
    res.status(500).json({ ok:false, error:e.message || String(e) });
  }
});

// Buscar usuario por cédula (sin autenticación, cedula en body JSON)
app.post('/api/usuario', async (req, res) => {
  const { cedula } = req.body;

  if (!cedula) {
    return res.status(400).json({ ok: false, error: 'Debe enviar la cédula en el body' });
  }

  const selectSql = `
    SELECT *
    FROM clientes
    WHERE NIT = ?
    LIMIT 1
  `;

  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql, [cedula]);
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
      }
      res.json({ ok: true, usuario: rows[0] });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[api] Error /api/usuario:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});



// Clasificación
app.get('/api/clasificacion', verifyToken, async (req, res) => {
  const selectSql = `
    SELECT c.sku, p.nombre, p.proveedor, p.linea, c.bod, b.descripcion as bodega, c.clasificacion
    FROM manager.clasificacion as c
    INNER JOIN manager.productos as p on c.sku = p.sku
    INNER JOIN manager.bodegas as b on b.idbodegas = c.bod
    ORDER BY c.sku
    LIMIT 1000000
  `;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql);
      res.json({ ok: true, rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[api] Error /api/clasificacion:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Inventario
app.get('/api/inventario', verifyToken, async (req, res) => {
  const selectSql = `
    SELECT i.sku, i.nombre, p.proveedor, p.linea, i.bod, b.descripcion as bodega, i.stock
    FROM manager.inventarios as i
    INNER JOIN manager.productos as p on p.sku = i.sku
    INNER JOIN manager.bodegas as b on b.idbodegas = i.bod
    ORDER BY i.sku
    LIMIT 1000000
  `;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql);
      res.json({ ok: true, rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[api] Error /api/inventario:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Alertas Habib
app.get('/api/alertashabib', verifyToken, async (req, res) => {
  const selectSql = `
    SELECT idalerta, sku, nombre, bod, stock, estado, rot30, rot60, rot90
    FROM manager.alertas_stock
    WHERE es_actual=1
    ORDER BY idalerta
    LIMIT 1000000
  `;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql);
      res.json({ ok: true, rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[api] Error /api/alertashabib:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Alertas Coopidrogas
app.get('/api/alertascoopidrogas', verifyToken, async (req, res) => {
  const selectSql = `
    SELECT idalerta, sku, descripcion, disponible, disponibleant, estadoinventario,
           precioreal, realant, estadoprecio, fecha
    FROM manager.alertascoopidrogas
    ORDER BY idalerta
    LIMIT 1000
  `;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql);
      res.json({ ok: true, rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[api] Error /api/alertascoopidrogas:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Sugerido
app.get('/api/sugerido', verifyToken, async (req, res) => {
  const selectSql = `
    SELECT s.sku, p.nombre, p.proveedor, p.linea, s.bod, s.stock, s.rot30, s.clasificacion,
           s.sugerido, s.diascobertura, s.estado, IFNULL(c.disponible,'ND') as coopi
    FROM manager.sugeridos_compra as s
    INNER JOIN manager.productos as p on p.sku = s.sku
    LEFT JOIN manager.coopidrogas as c on c.sku = s.sku
    LIMIT 100000
  `;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql);
      res.json({ ok: true, rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[api] Error /api/sugerido:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// dias de inventario
app.get('/api/diasinventario', verifyToken, async (req, res) => {
  const selectSql = `
  SELECT v.sku, i.nombre, p.proveedor, p.linea, v.bod, i.dias,i.stock, v.rot90, v.rotdia90,
  CASE WHEN i.stock = 0 THEN 0 WHEN i.stock > 0 AND v.rot90 < 0 THEN 10000 WHEN v.rot90 = 0 AND i.stock>0 THEN 10000 ELSE ROUND(i.stock / v.rotdia90, 0) END AS dias_inventario
  FROM manager.ventas as v
  inner join manager.inventarios as i on i.sku=v.sku and i.bod=v.bod
  inner join manager.productos as p on p.sku = v.sku limit 1000000;
  `;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(selectSql);
      res.json({ ok: true, rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[api] Error /api/diasinventario:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});


// Healthcheck
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

const PORT = Number(process.env.PORT || 5000);
app.listen(PORT, () => {
  console.log(`API lista en http://localhost:${PORT}`);
});
