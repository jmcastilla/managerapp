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
      username: "multicentro_mngbi01",
      password: "5D6RAPSDD54YWSB36FF4L4VVG25SQSGD6313A6RLKJNFBDG"
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

// Paso 2: Llamar al servicio para una lista específica (001 / 000)
async function getprecios(token, lista) {
  const body = {
    id_solicitud: 6254,
    service: "BI228NFP4TG33",
    appuser: "multictro",
    pwd: "S96SYBG4G4IK56M3",
    company: "multicentro",
    entity: "H41SGBG006QTTY",
    data: {
      usmng: "MNGBI",
      lista, // <- "001" o "000"
      fecha_corte: "19000101 11:10:30"
    }
  };

  const response = await axios.post(process.env.INVENTORY_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });

  // console.log(response.data);
  return response.data.data || []; // array de objetos
}

// Paso 3: Guardar en MySQL usando inserciones por lotes, incluyendo el campo lista
async function saveToDatabase(items, lista) {
  const conn = await mysql.createConnection({
    host: "206.189.175.188",
    user: "juan",
    password: "Juan12345!",
    database: "manager2"
  });

  try {
    await conn.beginTransaction();

    console.log(`[${new Date().toISOString()}] Limpiando datos de la lista ${lista}...`);
    await conn.execute('DELETE FROM precios WHERE idprecio>0 and lista = ?', [lista]);

    const batchSize = 1000;
    const insertQuery = `
      INSERT INTO precios (sku, medida, valor, lista)
      VALUES ?
    `;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const values = batch.map(item => [
        item.sku,
        item.umd,
        item.precio,
        lista
      ]);

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

// Paso 4: Orquestar el proceso para ambas listas
async function syncPrecios() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando sincronización...`);
    const token = await getToken();

    console.log(`→ Obteniendo precios lista 001...`);
    const maestro001 = await getprecios(token, "001");
    await saveToDatabase(maestro001, "001");
    console.log(`[${new Date().toISOString()}] Lista 001 guardada. Total items: ${maestro001.length}`);

    /*console.log(`→ Obteniendo precios lista 000...`);
    const maestro000 = await getprecios(token, "000");
    await saveToDatabase(maestro000, "000");
    console.log(`[${new Date().toISOString()}] Lista 000 guardada. Total items: ${maestro000.length}`);*/

    console.log(`[${new Date().toISOString()}] Sincronización exitosa.`);
  } catch (err) {
    console.error('Error durante sincronización:', err.message);
  }
}

// Ejecutar inmediatamente al iniciar (opcional)

syncPrecios();
// Exportar la función
module.exports = { syncPrecios };
