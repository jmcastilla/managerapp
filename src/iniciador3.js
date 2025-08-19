require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script
const { syncClientes } = require('./clientes');

// ================== SCHEDULERS ==================

// Análisis de alertas - cada 30 min
cron.schedule('*/3 * * * *', () => {
  console.log(`[cron] Análisis clientes`);
  syncClientes();
});
