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

// Paso 2: Llamar al servicio para una bodega específica
async function getmedicos(token) {
  const body = {
    id_solicitud: 6254,
    service: "BI225VCCLP477",
    appuser: "multictro",
    pwd: "S96SYBG4G4IK56M3",
    company: "multicentro",
    entity: "H41SGBG006QTTY",
    data: {
      usmng: "MNGBI",
      fecha_corte: "19000101 11:10:30"
    }
  };

  const response = await axios.post(process.env.INVENTORY_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });
  console.log(response.data)
  return response.data.data || []; // array de objetos
}

// Paso 3: Guardar en MySQL usando inserciones por lotes
async function saveToDatabase(items) {
  const conn = await mysql.createConnection({
    host: "206.189.175.188",
    user: "juan",
    password: "Juan12345!",
    database: "manager2"
  });

  console.log(`[${new Date().toISOString()}] Limpiando Base de datos...`);
  await conn.execute('DELETE FROM medicos WHERE idmedicos >= 0');

  // 1. Filtrar enteros Y eliminar duplicados usando un Map
  const uniqueItemsMap = new Map();

  items.forEach(item => {
    const codeAsNumber = Number(item.codigo);

    // Solo procesamos si es un entero válido
    if (item.codigo !== null && item.codigo !== '' && Number.isInteger(codeAsNumber)) {
      // Al usar el código como "llave" del Map, si se repite,
      // el valor se sobrescribe, dejando solo uno por ID.
      uniqueItemsMap.set(codeAsNumber, {
        id: codeAsNumber,
        nombre: item.nombre,
        especialidad: item.catalogo
      });
    }
  });

  const validItems = Array.from(uniqueItemsMap.values());

  console.log(`→ Registros totales recibidos: ${items.length}`);
  console.log(`→ Registros únicos y válidos: ${validItems.length}`);
  console.log(`→ Duplicados o inválidos eliminados: ${items.length - validItems.length}`);

  const batchSize = 1000;
  const insertQuery = `
    INSERT INTO medicos (idmedicos, nombre, especialidad)
    VALUES ?
  `;

  for (let i = 0; i < validItems.length; i += batchSize) {
    const batch = validItems.slice(i, i + batchSize);
    const values = batch.map(item => [
      item.id,
      item.nombre,
      item.especialidad
    ]);

    if (values.length > 0) {
      await conn.query(insertQuery, [values]);
    }
  }

  await conn.end();
}

// Paso 4: Orquestar el proceso
async function syncMedicos() {
  try {
    console.log(`[${new Date().toISOString()}] Iniciando sincronización...`);
    const token = await getToken();


    console.log(`→ Obteniendo productos...`);
    const maestro = await getmedicos(token);


    // Unificamos 03P y 03R como "03" y sumamos sus stocks
    //const inventarioUnificado = unificarBodegas(inventarioTotal);

    await saveToDatabase(maestro);

    console.log(`[${new Date().toISOString()}] Sincronización exitosa. Total items: ${maestro.length}`);
  } catch (err) {
    console.error('Error durante sincronización:', err.message);
  }
}
// Ejecutar inmediatamente al iniciar
module.exports = { syncMedicos };
