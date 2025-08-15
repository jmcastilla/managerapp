require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script
const { ejecutarAnalisis } = require('./analisis');        // cada 4 horas
const { ejecutarSugeridos } = require('./sugerido');       // cada 4 horas

// ================== SCHEDULERS ==================

// Análisis de alertas - cada 30 min
cron.schedule('10,40 * * * *', () => {
  console.log(`[cron] Análisis alertas`);
  ejecutarAnalisis();
});

// Sugeridos de compra - cada 30 min
cron.schedule('15,45 * * * *', () => {
  console.log(`[cron] Sugeridos de compra`);
  ejecutarSugeridos();
});
