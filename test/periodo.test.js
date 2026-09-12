// Testes PUROS (sem banco) do período PERSONALIZADO em lib/periodo.js —
// adicionado em 12/09/2026, pedido explícito do usuário: poder escolher
// qualquer intervalo de datas ("do dia 1 ao dia 15") em toda tela do ERP
// que já usa `calcularPeriodo`, não só Fluxo de Caixa/DRE (que já tinham
// essa opção com período PRÓPRIO, separado). Mesma convenção de
// desde/ate/limite já usada por lib/dre.js#calcularPeriodoDre e
// lib/fluxoCaixa.js#calcularPeriodoFluxoCaixa.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { calcularPeriodo, periodoParaDatasBRT, PERIODOS } = require('../lib/periodo');

describe('calcularPeriodo — período personalizado (12/09/2026)', () => {
  test('desde/ate válidos: devolve exatamente o intervalo pedido (inclusive nas duas pontas)', () => {
    const r = calcularPeriodo('personalizado', { desde: '2026-09-01', ate: '2026-09-15' });
    assert.equal(r.chave, 'personalizado');
    const { desde, ate } = periodoParaDatasBRT(r);
    assert.equal(desde, '2026-09-01');
    assert.equal(ate, '2026-09-15', 'o dia "até" precisa continuar incluído (limite exclusivo é o dia seguinte)');
  });

  test('um único dia (desde === ate) devolve um intervalo de 1 dia, nunca vazio', () => {
    const r = calcularPeriodo('personalizado', { desde: '2026-09-10', ate: '2026-09-10' });
    const { desde, ate } = periodoParaDatasBRT(r);
    assert.equal(desde, '2026-09-10');
    assert.equal(ate, '2026-09-10');
  });

  test('datas invertidas (até antes de desde): inverte sozinho, nunca devolve um intervalo vazio/negativo', () => {
    const r = calcularPeriodo('personalizado', { desde: '2026-09-15', ate: '2026-09-01' });
    const { desde, ate } = periodoParaDatasBRT(r);
    assert.equal(desde, '2026-09-01');
    assert.equal(ate, '2026-09-15');
  });

  test('sem desde/ate: cai no padrão de 30 dias, nunca quebra a tela', () => {
    const r = calcularPeriodo('personalizado', {});
    assert.equal(r.chave, '30d');
  });

  test('sem o segundo argumento nenhum (chamada antiga, sem opts): também cai no padrão de 30 dias', () => {
    const r = calcularPeriodo('personalizado');
    assert.equal(r.chave, '30d');
  });

  test('data em formato inválido: cai no padrão de 30 dias', () => {
    const r1 = calcularPeriodo('personalizado', { desde: '01/09/2026', ate: '2026-09-15' });
    assert.equal(r1.chave, '30d');
    const r2 = calcularPeriodo('personalizado', { desde: '2026-09-01', ate: 'não é uma data' });
    assert.equal(r2.chave, '30d');
  });

  test('intervalo maior que o limite de segurança (366 dias) é truncado, nunca gera uma série absurda', () => {
    const r = calcularPeriodo('personalizado', { desde: '2020-01-01', ate: '2026-09-15' });
    const dias = Math.round((r.ate.getTime() - r.desde.getTime()) / (24 * 60 * 60 * 1000));
    assert.ok(dias <= 367, `esperava no máximo ~366 dias (mais o limite exclusivo), recebeu ${dias}`);
  });

  test('label é "Período personalizado"', () => {
    const r = calcularPeriodo('personalizado', { desde: '2026-09-01', ate: '2026-09-15' });
    assert.equal(r.label, 'Período personalizado');
  });
});

describe('calcularPeriodo — compatibilidade com quem já chamava sem o segundo argumento', () => {
  test('todas as chaves antigas continuam funcionando exatamente como antes (sem passar opts)', () => {
    ['hoje', 'ontem', '7d', '30d', 'mes'].forEach((chave) => {
      const r = calcularPeriodo(chave);
      assert.equal(r.chave, chave);
      assert.ok(r.desde instanceof Date);
      assert.ok(r.ate instanceof Date);
    });
  });

  test('chave desconhecida continua caindo no padrão de 30 dias', () => {
    assert.equal(calcularPeriodo('isso-nao-existe').chave, '30d');
  });

  test('"personalizado" está na lista de PERIODOS (usada pelo dropdown/validações)', () => {
    assert.ok(PERIODOS.personalizado);
    assert.equal(PERIODOS.personalizado.label, 'Período personalizado');
  });
});
