require('dotenv').config();
const path = require('path');
const express = require('express');
const migrate = require('./db/migrate');
const { iniciarSincronizacaoAutomatica } = require('./lib/syncScheduler');
const { iniciarRenovacaoAutomatica: iniciarRenovacaoAutomaticaShopee } = require('./lib/shopeeTokenScheduler');
const { iniciarRadarDaIA } = require('./lib/ia/radarScheduler');
const { iniciarSincronizacaoAutomaticaAds } = require('./lib/adsScheduler');
const { iniciarGeracaoAutomaticaDeDespesasFixas } = require('./lib/despesasFixasScheduler');
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
const despesasFixasRouter = require('./routes/despesasFixas');
const fluxoCaixaRouter = require('./routes/fluxoCaixa');
const dreRouter = require('./routes/dre');
const faturamentoRouter = require('./routes/faturamento');
const notasFiscaisRouter = require('./routes/notasFiscais');
const adsRouter = require('./routes/ads');
const visaoGeralRouter = require('./routes/visaoGeral');
const iaGestoraRouter = require('./routes/iaGestora');
const performanceAnunciosRouter = require('./routes/performanceAnuncios');
const visitasConversaoRouter = require('./routes/visitasConversao');
const margemAnuncioRouter = require('./routes/margemAnuncio');
const contasBancariasRouter = require('./routes/contasBancarias');
const extratoBancarioRouter = require('./routes/extratoBancario');
const conciliacaoRouter = require('./routes/conciliacao');

const app = express();
const PORT = process.env.PORT || 3000;

// Limite padrão do express.json() é 100kb — pequeno demais pra planilha de
// extrato bancário enviada em base64 (Passo 2 da tarefa "Recebimentos +
// Fluxo de Caixa + IA Gestora", 27/08/2026). Sem multipart/multer no
// projeto (ver package.json), o arquivo viaja como base64 dentro do JSON
// (routes/extratoBancario.js) — por isso o limite sobe pra 20mb, suficiente
// pra um extrato semanal (centenas de linhas) sem abrir margem exagerada.
// Nenhuma outra rota muda de comportamento com isso.
app.use(express.json({ limit: '20mb' }));

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
app.use('/api/despesas-fixas', despesasFixasRouter);
app.use('/api/fluxo-caixa', fluxoCaixaRouter);
app.use('/api/dre', dreRouter);
app.use('/api/faturamento', faturamentoRouter);
app.use('/api/notas-fiscais', notasFiscaisRouter);
app.use('/api/ads', adsRouter);
app.use('/api/visao-geral', visaoGeralRouter);
app.use('/api/ia-gestora', iaGestoraRouter);
app.use('/api/performance-anuncios', performanceAnunciosRouter);
app.use('/api/visitas-conversao', visitasConversaoRouter);
app.use('/api/margem-anuncio', margemAnuncioRouter);
app.use('/api/contas-bancarias', contasBancariasRouter);
app.use('/api/extrato', extratoBancarioRouter);
app.use('/api/conciliacao', conciliacaoRouter);

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
    // Radar da IA — acompanhamento contínuo de anúncios e do negócio,
    // sempre no servidor, nunca dependendo do navegador aberto (ver
    // lib/ia/radarScheduler.js).
    iniciarRadarDaIA();
    // Product Ads (Mercado Livre) — sincronização em background, sempre no
    // servidor, nunca dependendo da tela Ads estar aberta (ver
    // lib/adsScheduler.js).
    iniciarSincronizacaoAutomaticaAds();
    // Despesas Fixas — geração automática das Contas a Pagar recorrentes,
    // sempre no servidor, nunca dependendo da tela estar aberta (ver
    // lib/despesasFixasScheduler.js).
    iniciarGeracaoAutomaticaDeDespesasFixas();
  });
}

start();
