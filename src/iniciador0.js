require('dotenv').config();
const cron = require('node-cron');

// Importar funciones principales de cada script

const { syncInventario } = require('./inventarioIA');  // cada 24 horas
const { syncProductos } = require('./productosIA');
const { syncPrecios } = require('./preciosIA');

// ================== SCHEDULERS ==================



  syncProductos();
