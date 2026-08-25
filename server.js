require('dotenv').config();
const path = require('path');
const express = require('express');
const migrate = require('./db/migrate');
const { iniciarSincronizacaoAutomatica } = require('./lib/syncScheduler');
const { iniciarRenovacaoAutomatica: iniciarRenovacaoAutomaticaShopee } = require('./lib/shopeeTokenScheduler');
const empresasRouter = require('./routes/empresas');
const integracoesRouter = require('./routes/integracoes');
const shopeeRouter = require('./routes/shopee');
const pedidosRouter = require('./routes/pedidos');
const custosRouter = require('./routes/custos');
const relatoriosRouter = require('./routes/relatorios');
const produtosRouter = require('./routes/produtos');
const fornecedoresRouter = require('./routes/fornecedores');
const anunciosRouter = require('./routes/anuncios');
const estoqueRouter = require('./routes/estoque');
const estoqueFullRouter = require('./routes/estoqueFull');
const comprasRouter = require('./routes/compras');
const produtosBaseRouter = require('./routes/produtosBase');
const estoqueProdutoBaseRouter = require('./routes/estoqueProdutoBase');
const contasPagarRouter = require('./routes/contasPagar');
const contasReceberRouter = require('./routes/contasReceber');
const recebimentosRouter = require('./routes/recebimentos');
const dreRouter = require('./routes/dre');
const faturamentoRouter = require('./routes/faturamento');
const notasFiscaisRouter = require('./routes/notasFiscais');
const adsRouter = require('./routes/ads');
const visaoGeralRouter = require('./routes/visaoGeral');
const iaGestoraRouter = require('./routes/iaGestora');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Healthcheck simples (útil para o provedor de hospedagem verificar o serviço)
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/empresas', empresasRouter);
app.use('/api/integracoes/mercadolivre', integracoesRouter);
app.use('/api/integracoes/shopee', shopeeRouter);
app.use('/api/pedidos', pedidosRouter);
app.use('/api', custosRouter);
app.use('/api/relatorios', relatoriosRouter);
app.use('/api/produtos', produtosRouter);
app.use('/api/fornecedores', fornecedoresRouter);
app.use('/api/anuncios', anunciosRouter);
app.use('/api/estoque', estoqueRouter);
app.use('/api/estoque-full', estoqueFullRouter);
app.use('/api/compras', comprasRouter);
app.use('/api/produtos-base', produtosBaseRouter);
app.use('/api/estoque-produto-base', estoqueProdutoBaseRouter);
app.use('/api/contas-pagar', contasPagarRouter);
app.use('/api/contas-receber', contasReceberRouter);
app.use('/api/recebimentos', recebimentosRouter);
app.use('/api/dre', dreRouter);
app.use('/api/faturamento', faturamentoRouter);
app.use('/api/notas-fiscais', notasFiscaisRouter);
app.use('/api/ads', adsRouter);
app.use('/api/visao-geral', visaoGeralRouter);
app.use('/api/ia-gestora', iaGestoraRouter);

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
    // Sincronização automática do Mercado Livre — sempre no servidor, nunca
    // depende de ninguém com o ERP aberto no navegador (ver lib/syncScheduler.js).
    iniciarSincronizacaoAutomatica();
    // Renovação automática do token das lojas Shopee conectadas — mesma
    // ideia (sempre no servidor), ver lib/shopeeTokenScheduler.js.
    iniciarRenovacaoAutomaticaShopee();
  });
}

start();
