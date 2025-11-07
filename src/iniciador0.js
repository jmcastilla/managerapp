require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script

const { syncInventario } = require('./inventarioIA');  // cada 24 horas
const { syncProductos } = require('./productosIA');
const { syncPrecios } = require('./preciosIA');

// ================== SCHEDULERS ==================

// Inventario - cada 30 min
cron.schedule('*/60 * * * *', () => {
  console.log(`[cron] precios`);
  syncPrecios();
});

cron.schedule('*/60 * * * *', () => {
  console.log(`[cron] inventario`);
  syncInventario();
});

cron.schedule('0 1 * * *', () => {
  console.log(`[cron] Productos`);
  syncProductos();
});
