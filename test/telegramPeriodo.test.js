// Testes de lib/periodo.js#resolverPeriodoDoTexto — função pura, sem
// banco/rede, pode rodar neste sandbox (mesmo padrão de test/telegram.test.js).
// (Essa função mora dentro de lib/periodo.js, não num arquivo separado — ver
// comentário em lib/periodo.js e 04-alteracoes.md, 21/09/2026.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolverPeriodoDoTexto } = require('../lib/periodo');

// "Agora" fixo pra testes determinísticos: 21/09/2026, 10h BRT.
const AGORA_FIXO = new Date('2026-09-21T13:00:00.000Z');

test('reconhece "hoje"', () => {
  const r = resolverPeriodoDoTexto('quanto vendi hoje?', AGORA_FIXO);
  assert.equal(r.periodoChave, 'hoje');
  assert.equal(r.reconhecido, true);
});

test('reconhece "ontem"', () => {
  const r = resolverPeriodoDoTexto('me dá o resultado de ontem', AGORA_FIXO);
  assert.equal(r.periodoChave, 'ontem');
  assert.equal(r.reconhecido, true);
});

test('reconhece "essa semana" como últimos 7 dias', () => {
  const r = resolverPeriodoDoTexto('como foram as vendas essa semana', AGORA_FIXO);
  assert.equal(r.periodoChave, '7d');
});

test('reconhece "últimos 30 dias"', () => {
  const r = resolverPeriodoDoTexto('faturamento dos ultimos 30 dias', AGORA_FIXO);
  assert.equal(r.periodoChave, '30d');
});

test('reconhece "esse mês" / "este mês"', () => {
  assert.equal(resolverPeriodoDoTexto('resultado desse mes', AGORA_FIXO).periodoChave, 'mes');
  assert.equal(resolverPeriodoDoTexto('quanto vendi este mês?', AGORA_FIXO).periodoChave, 'mes');
});

test('reconhece "mês passado" e calcula o intervalo certo (agosto/2026)', () => {
  const r = resolverPeriodoDoTexto('quanto vendi mes passado', AGORA_FIXO);
  assert.equal(r.periodoChave, 'personalizado');
  assert.equal(r.desde, '2026-08-01');
  assert.equal(r.ate, '2026-08-31');
});

test('"mês passado" em janeiro volta pro dezembro do ano anterior', () => {
  const janeiro = new Date('2026-01-15T13:00:00.000Z');
  const r = resolverPeriodoDoTexto('mes passado', janeiro);
  assert.equal(r.desde, '2025-12-01');
  assert.equal(r.ate, '2025-12-31');
});

test('reconhece nome de mês solto (ano corrente implícito)', () => {
  const r = resolverPeriodoDoTexto('quanto vendi em agosto?', AGORA_FIXO);
  assert.equal(r.periodoChave, 'personalizado');
  assert.equal(r.desde, '2026-08-01');
  assert.equal(r.ate, '2026-08-31');
});

test('reconhece nome de mês com ano explícito, mesmo em anos anteriores', () => {
  const r = resolverPeriodoDoTexto('me dá o relatório de dezembro de 2025', AGORA_FIXO);
  assert.equal(r.periodoChave, 'personalizado');
  assert.equal(r.desde, '2025-12-01');
  assert.equal(r.ate, '2025-12-31');
});

test('reconhece intervalo explícito de datas', () => {
  const r = resolverPeriodoDoTexto('compare de 01/08 a 15/08', AGORA_FIXO);
  assert.equal(r.periodoChave, 'personalizado');
  assert.equal(r.desde, '2026-08-01');
  assert.equal(r.ate, '2026-08-15');
});

test('reconhece intervalo explícito com ano em cada data', () => {
  const r = resolverPeriodoDoTexto('de 01/08/2025 até 15/08/2025', AGORA_FIXO);
  assert.equal(r.desde, '2025-08-01');
  assert.equal(r.ate, '2025-08-15');
});

test('reconhece um dia específico ("dia 05/08")', () => {
  const r = resolverPeriodoDoTexto('o que vendi no dia 05/08?', AGORA_FIXO);
  assert.equal(r.periodoChave, 'personalizado');
  assert.equal(r.desde, '2026-08-05');
  assert.equal(r.ate, '2026-08-05');
});

test('data inválida no intervalo (31/02) não é aceita — cai pro padrão', () => {
  const r = resolverPeriodoDoTexto('de 31/02 a 05/03', AGORA_FIXO);
  // 31/02 não existe — não deve virar "personalizado" com data quebrada.
  assert.equal(r.reconhecido, false);
  assert.equal(r.periodoChave, 'mes');
});

test('texto sem nenhuma data reconhecida usa o mês atual e avisa que não reconheceu', () => {
  const r = resolverPeriodoDoTexto('quais são meus produtos com prejuízo?', AGORA_FIXO);
  assert.equal(r.periodoChave, 'mes');
  assert.equal(r.reconhecido, false);
  assert.ok(r.descricaoUsada.includes('este mês'));
});
