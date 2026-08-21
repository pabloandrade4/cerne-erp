require('dotenv').config();
const path = require('path');
const express = require('express');
const migrate = require('./db/migrate');
const empresasRouter = require('./routes/empresas');
const integracoesRouter = require('./routes/integracoes');
const pedidosRouter = require('./routes/pedidos');
const custosRouter = require('./routes/custos');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Healthcheck simples (útil para o provedor de hospedagem verificar o serviço)
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/empresas', empresasRouter);
app.use('/api/integracoes/mercadolivre', integracoesRouter);
app.use('/api/pedidos', pedidosRouter);
app.use('/api', custosRouter);

// Front-end estático (o mesmo layout/design já aprovado)
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handler de erro central
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

async function start() {
  try {
    await migrate();
  } catch (err) {
    console.error('[start] falha ao aplicar schema do banco:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[server] Cerne ERP rodando na porta ${PORT}`);
  });
}

start();
