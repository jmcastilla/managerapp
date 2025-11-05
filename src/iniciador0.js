require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script

const { syncInventario2 } = require('./inventarioIA');  // cada 24 horas
const { syncProductos2 } = require('./productosIA');
const { syncPrecios } = require('./preciosIA');

// ================== SCHEDULERS ==================



  syncInventario2();
