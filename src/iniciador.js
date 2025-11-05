require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script
const { ejecutarClasificacionABC } = require('./clasificacion'); // cada 4 horas
const { runOnce } = require('./enviocorreo'); // cada 2 horas
const { runOnce2 } = require('./enviocorreointerno'); // cada 2 horas
const { runOnce3 } = require('./enviocorreobg'); // cada 2 horas
const { syncInventario } = require('./inventario');        // cada 30 min
const { syncProductos } = require('./productos');          // cada 24 horas
const { syncVentas } = require('./ventas');                // cada 30 min

// ================== SCHEDULERS ==================

// Inventario - cada 30 min
cron.schedule('*/30 * * * *', () => {
  console.log(`[cron] Inventario`);
  syncInventario();
});

// Productos - cada 24 horas (1 am)
cron.schedule('0 1 * * *', () => {
  console.log(`[cron] Productos`);
  syncProductos();
});

// Ventas - cada 30 min
cron.schedule('2,32 * * * *', () => {
  console.log(`[cron] Ventas`);
  syncVentas();
});


// Envío de correo - cada 5 min
cron.schedule('*/5 * * * *', () => {
  console.log(`[cron] Envío de correo`);
  runOnce();
});

// Envío de correo - cada 5 min
cron.schedule('*/5 * * * *', () => {
  console.log(`[cron] Envío de correo`);
  runOnce2();
});

// Envío de correo - cada 5 min
cron.schedule('*/5 * * * *', () => {
  console.log(`[cron] Envío de correo`);
  runOnce3();
});

// Clasificación ABC - cada 24 horas (2 am)
cron.schedule('0 2 * * *', () => {
  console.log(`[cron] Clasificación ABC`);
  ejecutarClasificacionABC();
});
