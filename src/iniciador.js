require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script
const { ejecutarAnalisis } = require('./analisis');        // cada 4 horas
const { ejecutarClasificacionABC } = require('./clasificacion'); // cada 4 horas
const { syncCoopidrogas } = require('./coopidrogas');      // cada 2 horas
const { runOnce: enviarCorreo } = require('./enviocorreo'); // cada 2 horas
const { syncInventario } = require('./inventario');        // cada 30 min
const { syncProductos } = require('./productos');          // cada 24 horas
const { ejecutarSugeridos } = require('./sugerido');       // cada 4 horas
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

// Coopidrogas - cada 30 min
cron.schedule('20,50 * * * *', () => {
  console.log(`[cron] Coopidrogas`);
  syncCoopidrogas();
});

// Envío de correo - cada 5 min
cron.schedule('*/5 * * * *', () => {
  console.log(`[cron] Envío de correo`);
  enviarCorreo();
});

// Clasificación ABC - cada 24 horas (2 am)
cron.schedule('0 2 * * *', () => {
  console.log(`[cron] Clasificación ABC`);
  ejecutarClasificacionABC();
});

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
