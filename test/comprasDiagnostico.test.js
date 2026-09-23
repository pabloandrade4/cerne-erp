const { test } = require('node:test');
const assert = require('node:assert/strict');

const { montarDadosDiagnostico, montarRelatorioTextoBase } = require('../lib/ia/comprasDiagnostico');

const CENARIO_COMPRAR_AGORA = {
  produtoBaseCodigo: 'CX-19X12X12',
  produtoBaseNome: 'Caixa 19x12x12',
  estoqueGalpao: 18000,
  estoqueFull: 12000,
  estoqueACaminho: 20000,
  venda7d: 20000,
  venda14d: 32000,
  venda30d: 55500,
  prazoFornecedorDias: 7,
  estoqueSegurancaDiasConfigurado: 7,
  custoUnitario: 0.5,
  fornecedorNome: 'Papelão ABC',
};

test('monta os dados do diagnóstico sem lançar e com o status coerente com a cobertura', () => {
  const dados = montarDadosDiagnostico(CENARIO_COMPRAR_AGORA);
  assert.equal(dados.produtoBaseCodigo, 'CX-19X12X12');
  assert.ok(dados.calc.diasCobertura > 0);
  assert.ok(['comprar_agora', 'ruptura', 'programar', 'atencao', 'saudavel', 'a_caminho'].includes(dados.calc.status));
});

test('relatório em texto nunca lança, inclui a tabela de indicadores e os motivos', () => {
  const dados = montarDadosDiagnostico(CENARIO_COMPRAR_AGORA);
  const texto = montarRelatorioTextoBase(dados);
  assert.match(texto, /\| Indicador \| Valor \|/);
  assert.match(texto, /Estoque no Galpão \(fora do Full\) \| 18\.000 un\./);
  assert.match(texto, /Estoque no Full \| 12\.000 un\./);
  assert.match(texto, /Fornecedor sugerido \| Papelão ABC/);
  assert.match(texto, /Por que a IA está recomendando essa compra/);
});

test('acelerando aparece como primeiro motivo, com os números reais', () => {
  const dados = montarDadosDiagnostico({ ...CENARIO_COMPRAR_AGORA, venda7d: 20000, venda30d: 30000 });
  assert.equal(dados.calc.acelerando, true);
  assert.match(dados.motivos[0], /aceleraram/);
});

test('sem fornecedor cadastrado, o motivo explica o cálculo conservador (prazo 0)', () => {
  const dados = montarDadosDiagnostico({ ...CENARIO_COMPRAR_AGORA, prazoFornecedorDias: null, fornecedorNome: null });
  assert.ok(dados.motivos.some((m) => m.includes('prazo de entrega')));
  const texto = montarRelatorioTextoBase(dados);
  assert.doesNotMatch(texto, /Fornecedor sugerido/);
});

test('produto saudável (estoque alto, sem urgência) não gera texto de recomendação de compra', () => {
  const dados = montarDadosDiagnostico({
    ...CENARIO_COMPRAR_AGORA,
    estoqueGalpao: 500000, estoqueFull: 0, estoqueACaminho: 0,
  });
  assert.equal(dados.calc.status, 'saudavel');
  const texto = montarRelatorioTextoBase(dados);
  assert.doesNotMatch(texto, /Recomendação: /);
});
