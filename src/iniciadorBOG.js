require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script
const { syncVentasHoy } = require('./ventasFac001BOG');                // cada 30 min
const { syncCompras } = require('./comprasBO');
const { syncInventario } = require('./inventarioBO');
const { syncProductos } = require('./productosBO');
const { syncVentas } = require('./ventasBO');
// ================== SCHEDULERS ==================


// fac001 - cada 24 horas (6 pm)
cron.schedule('0 5 * * *', () => {
  console.log(`[cron] ventasfactura001`);
  syncVentasHoy();
});

cron.schedule('10 5 * * *', () => {
  console.log(`[cron] compras`);
  syncCompras();
});

cron.schedule('2,32 * * * *', () => {
  console.log(`[cron] Inventario`);
  syncInventario();
});

cron.schedule('40 * * * *', () => {
  console.log(`[cron] Ventas`);
  syncVentas();
});

cron.schedule('30 5 * * *', () => {
  console.log(`[cron] PRODUCTOS`);
  syncProductos();
});
