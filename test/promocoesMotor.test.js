// Testes PUROS de lib/promocoesMotor.js — IA de Promoções, Fase B (13/09/2026).
// Cobrem exatamente as regras pedidas pelo usuário: nunca fabricar dado
// faltando (margemIncompleta), calcular a margem REAL (não só o desconto %),
// e classificar de forma determinística/explicável.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  calcularHistoricoPorSku,
  calcularCoberturaEstoque,
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

// 20/09/2026 — pedido explícito do usuário: "só me avisar de promoções
// quando for vender em um preço igual ou menor com a mesma margem ou uma
// margem até 3% menor, pois se eu vender com preço maior minha margem é
// maior mesmo". Regra SOMADA ao mínimo/conforto já existente (nunca
// substitui): mesmo com margem acima do mínimo exigido, se ela cair mais
// de 3 pontos percentuais abaixo da margem NORMAL do produto (preço
// cheio), a IA não recomenda entrar.
describe('classificar — margem normal do produto (pedido do usuário: nunca cair mais de 3 pontos abaixo da margem sem promoção)', () => {
  const base = { margemIncompleta: false, statusItem: 'candidate', margemMinimaPct: 14, margemConfortoPct: 0, temDesconto: true };

  test('margem cai exatamente 3 pontos (limite): ainda ENTRAR (>= é aceito)', () => {
    // mínimo exigido = 14 (sem conforto); folga = 21 — margem de 17 fica
    // dentro da faixa "entrar" (não cruza nem o mínimo nem a folga).
    const r = classificar({ ...base, margemPromoPct: 17, margemNormalPct: 20 });
    assert.equal(r.codigo, 'entrar');
  });

  test('margem cai 3.1 pontos (passou do limite): NÃO RECOMENDADO, mesmo bem acima do mínimo configurado', () => {
    const r = classificar({ ...base, margemPromoPct: 16.9, margemNormalPct: 20 });
    assert.equal(r.codigo, 'nao_recomendado');
  });

  test('mesma margem da normal (sem desconto real de margem): ENTRAR', () => {
    const r = classificar({ ...base, margemPromoPct: 20, margemNormalPct: 20, temDesconto: false });
    assert.equal(r.codigo, 'entrar');
  });

  test('margem promocional MAIOR que a normal (preço promocional acima do normal): nunca barrado pela regra — "se vender com preço maior, margem é maior mesmo"', () => {
    const r = classificar({ ...base, margemPromoPct: 20.5, margemNormalPct: 20, temDesconto: false });
    assert.equal(r.codigo, 'entrar');
  });

  test('sem margem normal calculável (precoNormal ausente): regra não se aplica, comportamento cai pro mínimo/conforto de sempre', () => {
    const r = classificar({ ...base, margemPromoPct: 16, margemNormalPct: null });
    assert.equal(r.codigo, 'entrar');
  });

  test('já ATIVA, margem caiu mais de 3 pontos abaixo da normal: RISCO DE MARGEM (confirmado pelo usuário em 20/09/2026 — "isso mesmo", a mesma tolerância vale pra MANTER uma promoção ativa)', () => {
    // 20% está acima do mínimo puro (14) e fora da faixa de risco absoluta
    // (limiteRisco ~16.1), mas caiu 30 pontos abaixo da margem normal (50%)
    // — bem mais que a tolerância de 3 pontos — por isso não é mais
    // "manter" sozinho: vira "risco_margem" pro usuário revisar.
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 20, margemNormalPct: 50 });
    assert.equal(r.codigo, 'risco_margem');
  });

  test('já ATIVA, margem dentro da tolerância da normal (queda de só 2 pontos): MANTER', () => {
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 20, margemNormalPct: 22 });
    assert.equal(r.codigo, 'manter');
  });

  test('já ATIVA, margem cai exatamente 3 pontos (limite aceito): ainda MANTER', () => {
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 20, margemNormalPct: 23 });
    assert.equal(r.codigo, 'manter');
  });

  test('já ATIVA, margem abaixo do mínimo absoluto continua SAIR mesmo com margem normal alta (SAIR nunca vira risco_margem)', () => {
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 10, margemNormalPct: 50 });
    assert.equal(r.codigo, 'sair');
  });

  test('já ATIVA, sem margem normal calculável: regra da queda não se aplica, só o mínimo/risco absoluto de sempre', () => {
    const r = classificar({ ...base, statusItem: 'started', margemPromoPct: 20, margemNormalPct: null });
    assert.equal(r.codigo, 'manter');
  });
});

// 20/09/2026 — pedido explícito do usuário: "sobre, meu estoque daquele
// produto estiver alto, quero que me avise". Ele confirmou (via pergunta
// feita de volta) o método: dias que o estoque dura, no ritmo real de
// vendas — nunca uma quantidade fixa em unidades.
describe('calcularCoberturaEstoque — "estoque alto" pelos dias que o estoque dura (pedido do usuário, 20/09/2026)', () => {
  test('cobertura abaixo do limite: não é estoque alto', () => {
    // ritmo = 180/90 = 2 unidades/dia ; cobertura = 100/2 = 50 dias (< 60)
    const r = calcularCoberturaEstoque({ estoqueAtual: 100, unidadesVendidas90d: 180, diasCoberturaAltaLimite: 60 });
    assert.equal(r.coberturaDiasEstoque, 50);
    assert.equal(r.estoqueAlto, false);
    assert.equal(r.motivoEstoqueAlto, null);
  });

  test('cobertura acima do limite: estoque alto, com motivo explicando os dias', () => {
    // ritmo = 180/90 = 2 unidades/dia ; cobertura = 200/2 = 100 dias (> 60)
    const r = calcularCoberturaEstoque({ estoqueAtual: 200, unidadesVendidas90d: 180, diasCoberturaAltaLimite: 60 });
    assert.equal(r.coberturaDiasEstoque, 100);
    assert.equal(r.estoqueAlto, true);
    assert.match(r.motivoEstoqueAlto, /100 dias/);
  });

  test('cobertura exatamente no limite: ainda não conta como alto (só acima)', () => {
    // ritmo = 180/90 = 2 unidades/dia ; cobertura = 120/2 = 60 dias (= limite)
    const r = calcularCoberturaEstoque({ estoqueAtual: 120, unidadesVendidas90d: 180, diasCoberturaAltaLimite: 60 });
    assert.equal(r.coberturaDiasEstoque, 60);
    assert.equal(r.estoqueAlto, false);
  });

  test('zero vendas no período mas com estoque > 0: conta como alto (produto parado), mesmo sem dia exato', () => {
    const r = calcularCoberturaEstoque({ estoqueAtual: 50, unidadesVendidas90d: 0, diasCoberturaAltaLimite: 60 });
    assert.equal(r.coberturaDiasEstoque, null);
    assert.equal(r.estoqueAlto, true);
    assert.match(r.motivoEstoqueAlto, /Nenhuma venda/);
  });

  test('zero vendas e zero estoque: não é alto (não há nada parado)', () => {
    const r = calcularCoberturaEstoque({ estoqueAtual: 0, unidadesVendidas90d: 0, diasCoberturaAltaLimite: 60 });
    assert.equal(r.estoqueAlto, false);
    assert.equal(r.motivoEstoqueAlto, null);
  });

  test('sem dado de estoque (SKU nunca sincronizado): nunca assume zero, devolve tudo neutro', () => {
    const r = calcularCoberturaEstoque({ estoqueAtual: null, unidadesVendidas90d: 180, diasCoberturaAltaLimite: 60 });
    assert.equal(r.coberturaDiasEstoque, null);
    assert.equal(r.estoqueAlto, false);
    assert.equal(r.motivoEstoqueAlto, null);
  });

  test('limite customizado por empresa (config_promocoes.dias_cobertura_alta): usa o valor passado, não o padrão de 60', () => {
    // ritmo = 180/90 = 2/dia ; cobertura = 100/2 = 50 dias — acima do limite customizado de 10
    const r = calcularCoberturaEstoque({ estoqueAtual: 100, unidadesVendidas90d: 180, diasCoberturaAltaLimite: 10 });
    assert.equal(r.estoqueAlto, true);
  });

  test('sem limite configurado (null/0): cai pro padrão de 60 dias', () => {
    // cobertura = 100 dias > 60 (padrão) -> alto
    const r = calcularCoberturaEstoque({ estoqueAtual: 200, unidadesVendidas90d: 180, diasCoberturaAltaLimite: null });
    assert.equal(r.estoqueAlto, true);
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

  test('item com tudo disponível: calcula margem real de verdade (não é só o desconto %) — mas cai NÃO RECOMENDADO pela margem normal (20/09/2026)', () => {
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
    // margem NORMAL (preço cheio 100): tarifas=10, frete=8, custo=30 -> resultado=52 -> 52%
    assert.equal(linha.margemNormalPct, 52);
    // 42.5% é uma margem ótima em termos absolutos (bem acima do mínimo de 14%),
    // mas cai 9.5 pontos percentuais abaixo da margem normal (52%) — mais do que
    // a tolerância de 3 pontos pedida pelo usuário em 20/09/2026 ("só me avisar
    // quando... a mesma margem ou uma margem até 3% menor") — por isso passa a
    // ser NÃO RECOMENDADO, mesmo com margem alta.
    assert.equal(linha.classificacaoCodigo, 'nao_recomendado');
    // margem real é BEM diferente do desconto % (20%) — prova que não é só desconto
    assert.notEqual(linha.margemRealPct, linha.descontoPct);
    assert.equal(linha.temDesconto, true); // preço promo (80) abaixo do normal (100)
    assert.equal(linha.margemConfortoPctUsada, 0); // não foi passado -> 0 (desligado)
  });

  test('desconto pequeno (queda de margem dentro dos 3 pontos aceitos): continua recomendando entrar', () => {
    const linha = analisarItemPromocao({
      // preço promo 96 (desconto de só 4%): tarifas=9.6, frete=8, custo=30 ->
      // resultado=96-9.6-8-30=48.4 -> 50.42% de margem — só 1.58 pontos abaixo
      // da margem normal (52%), dentro da tolerância de 3 pontos.
      item: { id: 'MLB5', status: 'candidate', original_price: 100, suggested_discounted_price: 96 },
      catalogEntry: { sku: 'SKU1', titulo: 'Produto Teste', imagemUrl: null, preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-4', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.margemNormalPct, 52);
    assert.equal(linha.margemRealPct, 50.42);
    assert.equal(linha.classificacaoCodigo, 'oportunidade');
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

  // 20/09/2026 — "estoque alto" passa de ponta a ponta por analisarItemPromocao,
  // usando o SKU do catálogo pra buscar no mapa de estoque real (mesmo mapa
  // vindo de ml_estoque_itens via lib/ia/promocoesCiclo.js).
  test('estoque alto passa de ponta a ponta e nunca muda a classificação de margem (sinal independente)', () => {
    const estoqueAtualPorSku = new Map([['SKU1', 200]]); // cobertura = 200/(1/90) bem acima do limite de 5 dias
    const linha = analisarItemPromocao({
      item: { id: 'MLB6', status: 'candidate', original_price: 100, suggested_discounted_price: 96 },
      catalogEntry: { sku: 'SKU1', titulo: 'Produto Teste', imagemUrl: null, preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      estoqueAtualPorSku,
      diasCoberturaAltaLimite: 5,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-5', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.estoqueAtual, 200);
    assert.equal(linha.unidadesVendidas90d, 1);
    assert.equal(linha.estoqueAlto, true);
    assert.match(linha.motivoEstoqueAlto, /dias/);
    // classificação continua vindo só da margem (mesmo resultado do teste
    // "desconto pequeno" acima) — estoque alto nunca entra nessa decisão.
    assert.equal(linha.classificacaoCodigo, 'oportunidade');
  });

  test('sem mapa de estoque (conta ainda sem sincronização): estoqueAtual fica null, nunca assume zero', () => {
    const linha = analisarItemPromocao({
      item: { id: 'MLB7', status: 'candidate', original_price: 100, suggested_discounted_price: 80 },
      catalogEntry: { sku: 'SKU1', titulo: 'Produto Teste', imagemUrl: null, preco: 100 },
      historicoPorSku,
      custoPorSku,
      aliquotaImposto: 0,
      margemMinimaPct: 14,
      contexto: { empresaId: 2, contaId: 1, promotionId: 'P-6', promotionType: 'DEAL', promotionLabel: 'Teste' },
    });
    assert.equal(linha.estoqueAtual, null);
    assert.equal(linha.estoqueAlto, false);
  });
});
