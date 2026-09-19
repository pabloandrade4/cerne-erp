// Testes PUROS de lib/promocoesMotor.js — IA de Promoções, Fase B (13/09/2026).
// Cobrem exatamente as regras pedidas pelo usuário: nunca fabricar dado
// faltando (margemIncompleta), calcular a margem REAL (não só o desconto %),
// e classificar de forma determinística/explicável.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  calcularHistoricoPorSku,
  precoPromocionalDoItem,
  divisaoDesconto,
  classificar,
  analisarItemPromocao,
} = require('../lib/promocoesMotor');

describe('precoPromocionalDoItem — usa exatamente o campo que cada tipo real de promoção devolve', () => {
  test('DEAL/SELLER_CAMPAIGN: usa suggested_discounted_price quando presente', () => {
    const r = precoPromocionalDoItem({ original_price: 68.79, min_discounted_price: 13.76, max_discounted_price: 65.35, suggested_discounted_price: 29.43 });
    assert.equal(r.precoPromo, 29.43);
    assert.equal(r.origemPrecoPromo, 'suggested_discounted_price');
  });

  test('SMART: usa price (preço já calculado daquela oferta) quando não há suggested_discounted_price', () => {
    const r = precoPromocionalDoItem({ original_price: 78.99, price: 58.23, meli_percentage: 2.912, seller_percentage: 23.088 });
    assert.equal(r.precoPromo, 58.23);
    assert.equal(r.origemPrecoPromo, 'price');
  });

  test('SELLER_COUPON_CAMPAIGN: calcula a partir de fixed_percentage', () => {
    const r = precoPromocionalDoItem({ original_price: 100, fixed_percentage: 5 });
    assert.equal(r.precoPromo, 95);
    assert.equal(r.origemPrecoPromo, 'fixed_percentage');
  });

  test('sem nenhum campo utilizável: precoPromo null (nunca inventa)', () => {
    const r = precoPromocionalDoItem({ original_price: 100 });
    assert.equal(r.precoPromo, null);
    assert.equal(r.origemPrecoPromo, null);
  });
});

describe('divisaoDesconto — só divide entre Meli/vendedor quando a API confirma; senão trata tudo como custo do vendedor', () => {
  test('com meli_percentage/seller_percentage (tipo SMART observado)', () => {
    const r = divisaoDesconto({ meli_percentage: 2.912, seller_percentage: 23.088 }, 78.99, 58.23);
    assert.equal(r.descontoBancadoMeliPct, 2.91);
    assert.equal(r.descontoBancadoVendedorPct, 23.09);
    assert.ok(r.descontoPct > 26 && r.descontoPct < 27);
  });

  test('sem divisão informada pela API: desconto inteiro fica como "bancado pelo vendedor" (conservador)', () => {
    const r = divisaoDesconto({}, 68.79, 29.43);
    assert.equal(r.descontoBancadoMeliPct, null);
    assert.equal(r.descontoBancadoVendedorPct, r.descontoPct);
  });
});

describe('classificar — 5 estados determinísticos', () => {
  const base = { margemIncompleta: false, margemMinimaPct: 14 };

  test('dados insuficientes vence qualquer outra regra', () => {
    const r = classificar({ ...base, margemIncompleta: true, margemPromoPct: 50 });
    assert.equal(r.codigo, 'dados_insuficientes');
  });

  test('candidato (ainda não está na promoção) com margem abaixo do mínimo: NÃO RECOMENDADO', () => {
    const r = classificar({ ...base, statusItem: 'candidate', margemPromoPct: 10 });
    assert.equal(r.codigo, 'nao_recomendado');
  });

  test('candidato com margem ok mas não folgada: ENTRAR', () => {
    const r = classificar({ ...base, statusItem: 'candidate', margemPromoPct: 16 });
    assert.equal(r.codigo, 'entrar');
  });

  test('candidato com margem bem acima do mínimo: OPORTUNIDADE', () => {
    const r = classificar({ ...base, statusItem: 'candidate', margemPromoPct: 30 });
    assert.equal(r.codigo, 'oportunidade');
  });

  test('já ativa na promoção, margem abaixo do mínimo: SAIR', () => {
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 10 });
    assert.equal(r.codigo, 'sair');
  });

  test('já ativa, margem ok mas perto do limite: RISCO DE MARGEM', () => {
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 15 });
    assert.equal(r.codigo, 'risco_margem');
  });

  test('já ativa, margem confortável: MANTER', () => {
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 25 });
    assert.equal(r.codigo, 'manter');
  });
});

// 15/09/2026 — "margem de conforto": pedido explícito do usuário: "voce
// deve me trazer promoções do mesmo valor com uma margem igual ou valores
// abaixo com uma margem um pouco menor mas respeitando a margem minima".
// Só se aplica a CANDIDATOS (ainda não ativos) COM desconto real — nunca a
// quem já está ativo na promoção, e nunca a quem está no preço normal (sem
// desconto, margem igual à margem normal do produto).
describe('classificar — margem de conforto (pedido do usuário: preferir preço cheio, tolerar só um pouco de desconto)', () => {
  const base = { margemIncompleta: false, margemMinimaPct: 14, margemConfortoPct: 5, statusItem: 'candidate' };

  test('sem desconto (mesmo preço, margem igual à normal): só o mínimo puro vale, mesmo com conforto configurado', () => {
    const r = classificar({ ...base, margemPromoPct: 16, temDesconto: false });
    assert.equal(r.codigo, 'entrar');
  });

  test('com desconto e margem só um pouco acima do mínimo PURO (16, exigido é 19): NÃO RECOMENDADO', () => {
    const r = classificar({ ...base, margemPromoPct: 16, temDesconto: true });
    assert.equal(r.codigo, 'nao_recomendado');
  });

  test('com desconto e margem acima do mínimo + conforto (20 >= 19): ENTRAR', () => {
    const r = classificar({ ...base, margemPromoPct: 20, temDesconto: true });
    assert.equal(r.codigo, 'entrar');
  });

  test('com desconto e margem exatamente no limite (19 = 14+5): ENTRAR (>= é aceito)', () => {
    const r = classificar({ ...base, margemPromoPct: 19, temDesconto: true });
    assert.equal(r.codigo, 'entrar');
  });

  test('margemConfortoPct = 0 (desligado, padrão): comportamento idêntico a antes da regra, mesmo com desconto', () => {
    const r = classificar({ ...base, margemConfortoPct: 0, margemPromoPct: 16, temDesconto: true });
    assert.equal(r.codigo, 'entrar');
  });

  test('promoção já ATIVA nunca usa a margem de conforto (regra é só pra decidir ENTRAR)', () => {
    // 16 ficaria NÃO RECOMENDADO como candidato com desconto (exigido 19),
    // mas como item já ATIVO só precisa passar do mínimo puro (14) e não
    // deveria mudar por causa da margem de conforto configurada.
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 20, temDesconto: true });
    assert.equal(r.codigo, 'manter'); // 20 está acima do mínimo puro (14) e fora da faixa de risco (limite 16.1)
  });

  test('folga (OPORTUNIDADE) é calculada sobre o mínimo EXIGIDO (com conforto), não sobre o mínimo puro', () => {
    // mínimo exigido = 19; folga = 19*1.5 = 28.5
    const abaixoDaFolga = classificar({ ...base, margemPromoPct: 28, temDesconto: true });
    const acimaDaFolga = classificar({ ...base, margemPromoPct: 29, temDesconto: true });
    assert.equal(abaixoDaFolga.codigo, 'entrar');
    assert.equal(acimaDaFolga.codigo, 'oportunidade');
  });
});

describe('calcularHistoricoPorSku — média de comissão (%) e frete (por unidade), ignorando itens com dado faltando', () => {
  test('calcula média corretamente e ignora item sem tarifas/frete', () => {
    const itensPeriodo = [
      { sku: 'ABC', tarifas: 10, valorTotalItem: 100, freteVendedor: 8, quantidade: 1 },
      { sku: 'ABC', tarifas: 20, valorTotalItem: 200, freteVendedor: 16, quantidade: 2 },
      { sku: 'ABC', tarifas: null, valorTotalItem: 50, freteVendedor: null, quantidade: 1 },
      { sku: 'XYZ', tarifas: null, valorTotalItem: 30, freteVendedor: 5, quantidade: 1 },
    ];
    const r = calcularHistoricoPorSku(itensPeriodo);
    const abc = r.get('ABC');
    assert.equal(abc.tarifasPctMedia, 0.1);
    assert.equal(abc.freteVendedorMedio, 8);
    assert.equal(abc.amostras, 2);
    // XYZ tem frete mas não tem tarifas -> min(0,1) = 0 amostras (não confiável)
    assert.equal(r.get('XYZ').amostras, 0);
  });

  test('SKU sem nenhum registro no histórico simplesmente não aparece no mapa', () => {
    const r = calcularHistoricoPorSku([{ sku: 'ABC', tarifas: 1, valorTotalItem: 10, freteVendedor: 1, quantidade: 1 }]);
    assert.equal(r.has('NUNCA-VENDIDO'), false);
  });
});

describe('analisarItemPromocao — integra tudo e nunca fabrica margem sem dado completo', () => {
  const historicoPorSku = calcularHistoricoPorSku([
    { sku: 'SKU1', tarifas: 10, valorTotalItem: 100, freteVendedor: 8, quantidade: 1 },
  ]);
  const custoPorSku = new Map([['SKU1', 30]]);

  test('item com tudo disponível: calcula margem real de verdade (não é só o desconto %)', () => {
    const linha = analisarItemPromocao({
      item: { id: 'MLB1', status: 'candidate', original_price: 100, suggested_discounted_price: 80 },
      catalogEntry: { sku: 'SKU1', titulo: 'Produto Teste', imagemUrl: 'https://x/img.jpg', preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-1', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.margemIncompleta, false);
    assert.equal(linha.precoPromo, 80);
    assert.equal(linha.custoProduto, 30);
    // tarifasEstimadas = 80 * 0.1 = 8 ; freteVendedorEstimado = 8
    // resultado = 80 - 8 - 8 - 0(imposto) - 30 = 34 ; margemRealPct = 34/80*100 = 42.5
    assert.equal(linha.tarifasEstimadas, 8);
    assert.equal(linha.freteVendedorEstimado, 8);
    assert.equal(linha.margemReal, 34);
    assert.equal(linha.margemRealPct, 42.5);
    assert.equal(linha.classificacaoCodigo, 'oportunidade');
    // margem real é BEM diferente do desconto % (20%) — prova que não é só desconto
    assert.notEqual(linha.margemRealPct, linha.descontoPct);
    assert.equal(linha.temDesconto, true); // preço promo (80) abaixo do normal (100)
    assert.equal(linha.margemConfortoPctUsada, 0); // não foi passado -> 0 (desligado)
  });

  test('margem de conforto passa por analisarItemPromocao de ponta a ponta: desconto real + margem só um pouco acima do mínimo puro vira NÃO RECOMENDADO', () => {
    const linha = analisarItemPromocao({
      // preço promo 65: tarifas=6.5, frete=8, custo=30 -> resultado=65-6.5-8-30=20.5 -> 31.5% de margem
      // mínimo puro 14 seria suficiente sozinho, mas com conforto 20 o exigido vira 34% -> abaixo, não recomendado
      item: { id: 'MLB3', status: 'candidate', original_price: 100, suggested_discounted_price: 65 },
      catalogEntry: { sku: 'SKU1', titulo: 'Produto Teste', imagemUrl: null, preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      margemConfortoPct: 20,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-2', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.temDesconto, true);
    assert.equal(linha.margemConfortoPctUsada, 20);
    assert.equal(linha.classificacaoCodigo, 'nao_recomendado');
  });

  test('sem desconto (preço promo = preço normal): margem de conforto não é exigida, mesmo configurada', () => {
    const linha = analisarItemPromocao({
      item: { id: 'MLB4', status: 'candidate', original_price: 100, suggested_discounted_price: 100 },
      catalogEntry: { sku: 'SKU1', titulo: 'Produto Teste', imagemUrl: null, preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      margemConfortoPct: 20,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-3', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.temDesconto, false);
    assert.notEqual(linha.classificacaoCodigo, 'nao_recomendado');
  });

  test('SKU sem custo cadastrado: margemIncompleta true, nunca calcula um número', () => {
    const linha = analisarItemPromocao({
      item: { id: 'MLB2', status: 'candidate', original_price: 100, suggested_discounted_price: 80 },
      catalogEntry: { sku: 'SKU-SEM-CUSTO', titulo: 'Produto Sem Custo', imagemUrl: null, preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-1', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.margemIncompleta, true);
    assert.equal(linha.margemReal, null);
    assert.match(linha.motivoIncompleto, /sem custo cadastrado/);
    assert.equal(linha.classificacaoCodigo, 'dados_insuficientes');
  });

  test('sem SKU identificado (catálogo sem SELLER_SKU): margemIncompleta true com motivo específico', () => {
    const linha = analisarItemPromocao({
      item: { id: 'MLB3', status: 'candidate', original_price: 100, suggested_discounted_price: 80 },
      catalogEntry: { sku: null, titulo: 'Produto Sem SKU', imagemUrl: null, preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-1', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.margemIncompleta, true);
    assert.match(linha.motivoIncompleto, /identificar o SKU/);
  });
});
