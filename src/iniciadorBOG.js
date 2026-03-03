require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script
const { syncVentasHoy } = require('./ventasFac001BOG');                // cada 30 min
// ================== SCHEDULERS ==================


// fac001 - cada 24 horas (6 pm)
cron.schedule('0 5 * * *', () => {
  console.log(`[cron] ventasfactura001`);
  syncVentasHoy();
});
