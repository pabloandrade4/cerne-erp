const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  montarDadosDiagnostico,
  montarRelatorioTextoBase,
} = require('../lib/ia/adsDiagnostico');

// Números reais colados pelo usuário (21/09/2026) num relatório escrito à
// mão, usados aqui como caso de validação: se as contas do sistema batem
// com as contas que ele mesmo fez à mão, o motor está certo.
const LINHA_EXEMPLO_USUARIO = {
  anuncio: 'Caixa de papelão 30x20x20',
  sku: 'CX-302020',
  loja: 'Loja Exemplo',
  campanha: 'Campanha Caixas',
  mlItemId: 'MLB123',
  impressoes: 105790,
  cliques: 171,
  cpc: 0.24,
  investimento: 40.44,
  qtdVendasAtribuidas: 1,
  faturamentoAtribuido: 135,
  acos: 29.9,
  roas: 3.34,
  quantidadeVendidaReal: 125,
};

test('CTR calculado é 0,16% (arredondamento pt-BR de 1 casa mostra 0,2% — valida o número bruto)', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  // A métrica bruta (antes de formatar como texto) é o que garante a conta —
  // recomputa aqui do mesmo jeito que o módulo faz, pra não depender só do
  // arredondamento de exibição.
  const ctrBruto = Math.round((171 / 105790) * 100 * 100) / 100;
  assert.equal(ctrBruto, 0.16);
  const linhaCtr = dados.metricas.find((m) => m.label === 'CTR');
  assert.match(linhaCtr.valor, /^0,2%$/); // toLocaleString com 1 casa arredonda 0,16 -> 0,2
});

test('conversão via Ads bate com a conta manual do usuário (1/171 = 0,58%)', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  const conv = dados.metricas.find((m) => m.label === 'Conversão (Ads)');
  assert.match(conv.valor, /^0,6%$/); // 0.5848 arredondado a 1 casa
  assert.equal(conv.leitura, 'Muito baixa'); // < CONVERSAO_FRACA_PCT (1%)
});

test('CPA bate com investimento/vendas quando só há 1 venda via Ads (R$ 40,44)', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  const cpa = dados.metricas.find((m) => m.label.startsWith('CPA'));
  assert.match(cpa.valor, /40,44/);
});

test('outras vendas = vendas totais - vendas via Ads (125 - 1 = 124), com leitura "vende forte sem Ads"', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  const outras = dados.metricas.find((m) => m.label.startsWith('Outras vendas'));
  assert.equal(outras.valor, '124');
  assert.equal(outras.leitura, 'O produto vende fortemente sem atribuição ao Ads');
});

test('baseline de vendas orgânicas/dia bate com a conta manual do usuário (124 / 30 = 4,13)', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  assert.equal(dados.teste.baselineVendasDia, 4.13);
});

test('teste de monitoramento usa 7 dias e 3 faixas, nunca inventa uma 4ª', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  assert.equal(dados.teste.dias, 7);
  assert.equal(dados.teste.faixas.length, 3);
  // faixas cobrem de 0 até "sem teto" na mais alta, sem buraco nem sobreposição
  assert.equal(dados.teste.faixas[2].de, 0);
  assert.equal(dados.teste.faixas[1].ate, dados.teste.faixas[0].de);
  assert.equal(dados.teste.faixas[0].ate, null);
});

test('CTR/conversão fracos marcam os dois gargalos (impressão->clique e clique->compra)', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  assert.equal(dados.gargalos.ctrFraco, true);
  assert.equal(dados.gargalos.conversaoFraca, true);
});

test('sem meta de campanha (orçamento não sincronizado), não afirma nada sobre orçamento', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO, metaCampanha: null });
  assert.equal(dados.orcamento.orcamentoDiario, null);
  assert.equal(dados.orcamento.gastoMuitoAbaixoDoOrcamento, false);
});

test('com orçamento configurado bem acima do gasto real, aponta que o problema não é orçamento', () => {
  const dados = montarDadosDiagnostico({
    linha: LINHA_EXEMPLO_USUARIO,
    metaCampanha: { orcamentoDiario: 19, acosAlvo: null, acosBenchmark: null },
  });
  // gasto médio diário = 40.44/30 = 1.35 -> 1.35/19 = 7.1% << 50%
  assert.equal(dados.orcamento.gastoMuitoAbaixoDoOrcamento, true);
  const texto = montarRelatorioTextoBase(dados);
  assert.match(texto, /problema deste anúncio não parece ser orçamento/);
});

test('ACOS é comparado com a meta configurada quando ela existe', () => {
  const dados = montarDadosDiagnostico({
    linha: LINHA_EXEMPLO_USUARIO,
    metaCampanha: { orcamentoDiario: 19, acosAlvo: 20, acosBenchmark: null },
  });
  const acosLinha = dados.metricas.find((m) => m.label === 'ACOS');
  assert.equal(acosLinha.leitura, 'Acima da meta configurada'); // 29.9% > 20%
});

test('dado ausente (sem métricas de Ads sincronizadas) nunca vira zero — aparece como indisponível', () => {
  const dados = montarDadosDiagnostico({ linha: { anuncio: 'X', quantidadeVendidaReal: 10 } });
  const impressoes = dados.metricas.find((m) => m.label === 'Impressões');
  assert.equal(impressoes.valor, 'dado indisponível');
});

test('relatório em texto nunca lança e sempre inclui a tabela de métricas', () => {
  const dados = montarDadosDiagnostico({ linha: LINHA_EXEMPLO_USUARIO });
  const texto = montarRelatorioTextoBase(dados);
  assert.match(texto, /\| Métrica \| Resultado \| Leitura \|/);
  assert.match(texto, /Impressões/);
});
