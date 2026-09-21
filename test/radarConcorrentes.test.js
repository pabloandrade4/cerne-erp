const { test } = require('node:test');
const assert = require('node:assert/strict');

const radar = require('../lib/radarConcorrentes');

test('extrai item_id do Mercado Livre de links reais', () => {
  assert.equal(radar.extrairItemIdML('https://produto.mercadolivre.com.br/MLB-4712675795-kit'), 'MLB4712675795');
  assert.equal(radar.extrairItemIdML('https://www.mercadolivre.com.br/anuncio?item_id=MLB4712675795&x=1'), 'MLB4712675795');
  assert.equal(radar.extrairItemIdML('sem nenhum id aqui'), null);
  assert.equal(radar.extrairItemIdML(''), null);
});

test('vendas/dia estimadas fica null na primeira leitura (sem leitura anterior)', () => {
  assert.equal(radar.calcularVendasDiaEstimado(null, 120, new Date()), null);
});

test('vendas/dia estimadas fica null quando a leitura anterior não tem vendidos_total', () => {
  const anterior = { vendidos_total: null, lido_em: new Date(Date.now() - 2 * 86400000) };
  assert.equal(radar.calcularVendasDiaEstimado(anterior, 120, new Date()), null);
});

test('vendas/dia estimadas fica null quando o total caiu (dado inconsistente)', () => {
  const anterior = { vendidos_total: 150, lido_em: new Date(Date.now() - 2 * 86400000) };
  assert.equal(radar.calcularVendasDiaEstimado(anterior, 120, new Date()), null);
});

test('vendas/dia estimadas fica null quando passou menos de meio dia entre leituras', () => {
  const anterior = { vendidos_total: 100, lido_em: new Date(Date.now() - 60000) };
  assert.equal(radar.calcularVendasDiaEstimado(anterior, 110, new Date()), null);
});

test('vendas/dia estimadas calcula a diferença real dividida pelos dias decorridos', () => {
  const agora = new Date('2026-09-21T12:00:00Z');
  const anterior = { vendidos_total: 100, lido_em: new Date('2026-09-19T12:00:00Z') }; // 2 dias antes
  assert.equal(radar.calcularVendasDiaEstimado(anterior, 130, agora), 15); // 30 vendas / 2 dias
});

test('gera alerta de preço quando o preço muda, citando antes e depois', () => {
  const alertas = radar.gerarAlertas({
    leituraAnterior: { preco: 42.90, em_promocao: false, imagem_url: 'a.jpg', titulo: 'T', frete_tipo: null, frete_gratis: false, status_anuncio: 'active' },
    atual: { preco: 38.90, emPromocao: false, imagemUrl: 'a.jpg', titulo: 'T', freteTipo: null, freteGratis: false, statusAnuncio: 'active' },
    nomeConcorrente: 'Caixas Forte',
  });
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].tipo, 'preco');
  assert.match(alertas[0].mensagem, /R\$ 42,90/);
  assert.match(alertas[0].mensagem, /R\$ 38,90/);
});

test('gera alerta de promoção só quando em_promocao muda', () => {
  const base = { preco: 40, imagem_url: 'a.jpg', titulo: 'T', frete_tipo: null, frete_gratis: false, status_anuncio: 'active' };
  const alertas = radar.gerarAlertas({
    leituraAnterior: { ...base, em_promocao: false },
    atual: { preco: 40, emPromocao: true, imagemUrl: 'a.jpg', titulo: 'T', freteTipo: null, freteGratis: false, statusAnuncio: 'active' },
    nomeConcorrente: 'Box Premium',
  });
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].tipo, 'promocao');
});

test('gera alerta de status crítico quando o anúncio encerra', () => {
  const base = { preco: 40, em_promocao: false, imagem_url: 'a.jpg', titulo: 'T', frete_tipo: null, frete_gratis: false };
  const alertas = radar.gerarAlertas({
    leituraAnterior: { ...base, status_anuncio: 'active' },
    atual: { preco: 40, emPromocao: false, imagemUrl: 'a.jpg', titulo: 'T', freteTipo: null, freteGratis: false, statusAnuncio: 'closed' },
    nomeConcorrente: 'Embala Mais',
  });
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].tipo, 'status');
  assert.equal(alertas[0].severidade, 'oportunidade');
});

test('não gera nenhum alerta quando nada muda entre duas leituras', () => {
  const base = { preco: 40, em_promocao: false, imagem_url: 'a.jpg', titulo: 'T', frete_tipo: null, frete_gratis: false, status_anuncio: 'active' };
  const alertas = radar.gerarAlertas({
    leituraAnterior: base,
    atual: { preco: 40, emPromocao: false, imagemUrl: 'a.jpg', titulo: 'T', freteTipo: null, freteGratis: false, statusAnuncio: 'active' },
    nomeConcorrente: 'X',
  });
  assert.equal(alertas.length, 0);
});

test('primeira leitura (sem leitura anterior) nunca gera alerta de diferença', () => {
  const alertas = radar.gerarAlertas({
    leituraAnterior: null,
    atual: { preco: 40, emPromocao: false, imagemUrl: 'a.jpg', titulo: 'T', freteTipo: null, freteGratis: false, statusAnuncio: 'active' },
    nomeConcorrente: 'X',
  });
  assert.equal(alertas.length, 0);
});
