// Testes de INTEGRAÇÃO (precisa de Postgres local) do Fluxo de Caixa.
// Ativado em 25/08/2026, REESCRITO na ETAPA 3 em 27/08/2026 (ver
// docs/04-alteracoes.md): REALIZADO passa a vir de extrato_movimentos,
// saldo inicial por conta bancária, transferências internas. Roda as
// funções REAIS de lib/fluxoCaixa.js contra o banco de teste.
//
// Cada teste numerado (TESTE 1, 2/3, 5/10, 7, 12...) usa sua PRÓPRIA conta
// bancária isolada (nunca reaproveita a de outro teste) e sempre escopa as
// chamadas de gerarFluxoDeCaixa com `contaBancariaId` quando checa um valor
// EXATO de realizado/saldo — isso é proposital: um valor absoluto (ex.
// "saidasRealizadas === 500") só pode ser uma prova confiável se nenhum
// outro teste puder ter sujado a mesma conta ou o mesmo total consolidado
// antes dele rodar. TESTE 6 e TESTE 12, que precisam olhar pro total da
// EMPRESA (contas a pagar/receber e recebimentos de marketplace são sempre
// em nível de empresa, nunca por conta), comparam ANTES/DEPOIS dentro do
// próprio teste em vez de assumir um valor absoluto "limpo" — assim
// continuam corretos não importa o que outros testes tenham feito.
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test fluxoCaixa.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900; // testes de período/despesa fixa — reaproveita o banco de teste já seedado, inalterado desde 25/08/2026
const EMPRESA_ETAPA3 = 975; // dedicada aos testes novos da ETAPA 3 (nunca colide com outros arquivos de teste)
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';

function round2(n) { return Math.round(n * 100) / 100; }

describe('Fluxo de Caixa — 25/08/2026 (período/despesa fixa — arquitetura inalterada pela ETAPA 3)', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let fluxoCaixa, despesasFixas, pool;
  const idsDespesas = [];

  before(async () => {
    fluxoCaixa = require('../lib/fluxoCaixa');
    despesasFixas = require('../lib/despesasFixas');
    pool = require('../db/pool');

    // Limpeza DEFENSIVA: uma execução anterior interrompida antes do seu
    // próprio after() (ex.: falha de asserção no meio, ou erro de conexão)
    // pode deixar despesas_fixas/contas_pagar de teste para trás — a
    // empresa 900 é fixa e reaproveitada entre execuções, então isso
    // contaminaria o total de "despesasFixasPrevistas" da próxima vez.
    // Mesma ordem de FKs do after() abaixo: contas_pagar antes de
    // despesas_fixas.
    await pool.query(
      `DELETE FROM contas_pagar WHERE empresa_id = $1 AND despesa_fixa_id IN (SELECT id FROM despesas_fixas WHERE empresa_id = $1 AND descricao LIKE $2)`,
      [EMPRESA_ID, PREFIXO_TESTE + '%']
    );
    await pool.query(`DELETE FROM despesas_fixas WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
  });

  after(async () => {
    // ORDEM IMPORTA: contas_pagar tem uma FK pra despesas_fixas
    // (contas_pagar_despesa_fixa_id_fkey) — apagar despesas_fixas primeiro
    // quebra essa FK. Sempre apagar quem REFERENCIA antes de quem é
    // referenciado.
    await pool.query(`DELETE FROM contas_pagar WHERE empresa_id = $1 AND despesa_fixa_id = ANY($2::int[])`, [EMPRESA_ID, idsDespesas]);
    await pool.query(`DELETE FROM despesas_fixas WHERE empresa_id = $1 AND descricao LIKE $2`, [EMPRESA_ID, PREFIXO_TESTE + '%']);
  });

  describe('período próprio (7/15/30 dias, este mês, próximo mês, personalizado)', () => {
    test('7/15/30 dias contam a partir de HOJE (inclusive) — diferente do período do header, que olha pra trás', () => {
      const hoje = despesasFixas.hojeBRT();
      const p7 = fluxoCaixa.calcularPeriodoFluxoCaixa('7d', {});
      assert.equal(p7.desde, hoje);
      const dias = (new Date(p7.ate + 'T00:00:00Z') - new Date(p7.desde + 'T00:00:00Z')) / 86400000;
      assert.equal(dias, 6, '7 dias = hoje + mais 6 = 7 dias no total');
    });

    test('proximoMes é o mês de calendário seguinte inteiro', () => {
      const hoje = despesasFixas.hojeBRT();
      const [y, m] = hoje.split('-').map(Number);
      const p = fluxoCaixa.calcularPeriodoFluxoCaixa('proximoMes', {});
      const esperadoMes = m === 12 ? 1 : m + 1;
      const [, pm] = p.desde.split('-').map(Number);
      assert.equal(pm, esperadoMes);
      assert.equal(p.desde.slice(8, 10), '01');
    });

    test('personalizado inverte desde/ate quando vem trocado, e nunca passa do limite de segurança', () => {
      const p = fluxoCaixa.calcularPeriodoFluxoCaixa('personalizado', { desde: '2026-12-31', ate: '2026-01-01' });
      assert.equal(p.desde, '2026-01-01');
      assert.equal(p.ate, '2026-12-31');
    });
  });

  describe('nunca conta uma despesa fixa 2x quando ela já virou conta a pagar (PREVISTO — inalterado pela ETAPA 3)', () => {
    test('despesa fixa prevista some do total assim que a conta a pagar correspondente é gerada', async () => {
      const hoje = despesasFixas.hojeBRT();
      const [y, m] = hoje.split('-').map(Number);
      const inicioDoMes = `${y}-${String(m).padStart(2, '0')}-01`;

      const criada = await despesasFixas.criarDespesaFixa({
        empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' Aluguel Fluxo', categoria: 'Aluguel', valor: 3000,
        frequencia: 'mensal', diaVencimento: 28, dataInicio: inicioDoMes,
      });
      assert.equal(criada.errors, undefined);
      idsDespesas.push(criada.despesa.id);

      const antes = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: 'mes' });
      assert.equal(antes.resumoFormula.despesasFixasPrevistas, 3000);
      const saidasPrevistasAntes = antes.cards.saidasPrevistas;

      const g = await despesasFixas.gerarContasPagarAutomaticas({ empresaId: EMPRESA_ID });
      assert.ok(g.detalhes.find((d) => d.despesaFixaId === criada.despesa.id));

      const depois = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ID, periodoChave: 'mes' });
      assert.equal(depois.resumoFormula.despesasFixasPrevistas, 0, 'não deveria mais aparecer como "prevista" — já é uma conta a pagar de verdade');
      assert.equal(depois.cards.saidasPrevistas, saidasPrevistasAntes, 'total de saídas previstas do período tem que ser o MESMO — nunca R$6.000 em vez de R$3.000');
    });
  });
});

describe('Fluxo de Caixa — ETAPA 3 (27/08/2026): REALIZADO a partir de extrato_movimentos, saldo por conta, transferências internas', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let fluxoCaixa, contasBancarias, contasPagar, contasReceber, conciliacaoBancaria, pool;
  // TESTE 9/10 e TESTE 11 compartilham DE PROPÓSITO um par de contas
  // dedicado (nenhum outro teste toca nelas) — são conceitualmente a mesma
  // história (saldo por conta/consolidado, depois uma transferência entre
  // as duas mesmas contas).
  let nubank2, mercadoPago2;
  const hojeBRT = () => require('../lib/despesasFixas').hojeBRT();

  async function criarContaIsolada(nome) {
    const r = await contasBancarias.criarContaBancaria({ empresaId: EMPRESA_ETAPA3, nome: `${PREFIXO_TESTE} ${nome}`, banco: 'Teste' });
    assert.equal(r.errors, undefined, `falha ao criar conta de teste "${nome}"`);
    return r.conta;
  }

  async function criarImportacaoDummy(contaBancariaId) {
    const { rows } = await pool.query(
      `INSERT INTO extrato_importacoes (empresa_id, conta_bancaria_id, nome_arquivo, formato, status, importado_por)
       VALUES ($1,$2,'teste.csv','csv','concluida', $3) RETURNING id`,
      [EMPRESA_ETAPA3, contaBancariaId, PREFIXO_TESTE]
    );
    return rows[0].id;
  }

  async function inserirMovimento({ contaBancariaId, importacaoId, data, tipo, valor, descricao, categoria }) {
    const hash = crypto.randomBytes(16).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO extrato_movimentos (empresa_id, conta_bancaria_id, importacao_id, data, descricao, valor, tipo, hash_dedup, categoria)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [EMPRESA_ETAPA3, contaBancariaId, importacaoId, data, descricao || (PREFIXO_TESTE + ' movimento'), valor, tipo, hash, categoria || null]
    );
    return rows[0].id;
  }

  before(async () => {
    fluxoCaixa = require('../lib/fluxoCaixa');
    contasBancarias = require('../lib/contasBancarias');
    contasPagar = require('../lib/contasPagar');
    contasReceber = require('../lib/contasReceber');
    conciliacaoBancaria = require('../lib/conciliacaoBancaria');
    pool = require('../db/pool');

    await pool.query(
      `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo) VALUES ($1,$2,$3,$4,TRUE)
       ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
      [EMPRESA_ETAPA3, '97500000000175', PREFIXO_TESTE + ' Empresa ETAPA 3 LTDA', PREFIXO_TESTE + ' Empresa ETAPA 3']
    );

    // Limpeza DEFENSIVA: garante um estado zerado mesmo que uma execução
    // anterior desta mesma suíte tenha sido interrompida antes de rodar seu
    // próprio after() (empresa 975 é fixa e reaproveitada entre execuções).
    // Ordem importa (FKs): movimentos/importações antes de contas
    // bancárias; contas_pagar/receber e recebimentos antes de nada que
    // dependa deles.
    await pool.query(`DELETE FROM extrato_movimentos WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM extrato_importacoes WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM fluxo_caixa_saldo_inicial_conta WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM fluxo_caixa_saldo_inicial WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM contas_pagar WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM contas_receber WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM recebimentos_marketplace WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM contas_bancarias WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
  });

  after(async () => {
    await pool.query(`DELETE FROM extrato_movimentos WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM extrato_importacoes WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM fluxo_caixa_saldo_inicial_conta WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM fluxo_caixa_saldo_inicial WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM contas_pagar WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM contas_receber WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM recebimentos_marketplace WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM contas_bancarias WHERE empresa_id = $1`, [EMPRESA_ETAPA3]);
    await pool.query(`DELETE FROM empresas WHERE id = $1`, [EMPRESA_ETAPA3]);
    await pool.end();
  });

  describe('TESTE 1 — movimento bancário sem conta a pagar correspondente aparece no REALIZADO', () => {
    test('saída sem nenhuma conta a pagar lançada conta como realizado (conta isolada, valor exato)', async () => {
      const hoje = hojeBRT();
      const c1 = await criarContaIsolada('Conta T1');
      const imp = await criarImportacaoDummy(c1.id);
      await inserirMovimento({ contaBancariaId: c1.id, importacaoId: imp, data: hoje, tipo: 'saida', valor: 500 });

      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d', contaBancariaId: c1.id });
      assert.equal(f.cards.saidasRealizadas, 500, 'R$500 tem que aparecer como realizado mesmo sem conta a pagar nenhuma');
      const diaHoje = f.serieDiaria.find((d) => d.dia === hoje);
      assert.equal(diaHoje.realizado.saidas, 500);

      // Inativa a conta deste teste: ela nunca teve saldo inicial
      // configurado, e uma conta ATIVA sem saldo inicial faz o consolidado
      // da EMPRESA (usado por outros testes, ex. TESTE 9/10) virar `null`
      // de propósito (ver saldosPorContaEDaEmpresaEm) — comportamento
      // correto do produto, mas que exige que cada teste "descarte" sua
      // conta auxiliar depois de usá-la.
      await contasBancarias.inativar(c1.id);
    });
  });

  describe('TESTE 2/3 — conta prevista, depois conciliada: previsto some, realizado permanece, NUNCA soma os dois (prova de não duplicidade #1)', () => {
    test('previsto -R$5.000 + realizado -R$5.000 (após conciliar) = -R$5.000, nunca -R$10.000', async () => {
      const hoje = hojeBRT();
      const c2 = await criarContaIsolada('Conta T2/3');
      const criada = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ETAPA3, descricao: PREFIXO_TESTE + ' Fornecedor ABC', valor: 5000, vencimento: hoje });
      assert.equal(criada.errors, undefined);

      // ANTES do banco mostrar o pagamento: só PREVISTO, realizado zerado
      // (conta bancária dedicada e ainda sem nenhum movimento — valor
      // absoluto confiável).
      const antes = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d', contaBancariaId: c2.id });
      assert.equal(antes.cards.saidasPrevistas, 5000, 'TESTE 2 — previsto R$5.000');
      assert.equal(antes.cards.saidasRealizadas, 0, 'TESTE 2 — realizado R$0 (nada aconteceu no banco ainda)');

      // Aparece no banco e é conciliado.
      const imp = await criarImportacaoDummy(c2.id);
      const movId = await inserirMovimento({ contaBancariaId: c2.id, importacaoId: imp, data: hoje, tipo: 'saida', valor: 5000, descricao: PREFIXO_TESTE + ' pagamento boleto' });
      const conc = await conciliacaoBancaria.confirmarConciliacao({ movimentoId: movId, tipo: 'conta_pagar', alvoId: criada.conta.id });
      assert.equal(conc.errors, undefined);
      assert.equal(conc.alvo.status, 'pago');

      const depois = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d', contaBancariaId: c2.id });
      assert.equal(depois.cards.saidasPrevistas, 0, 'TESTE 3 — previsto tem que desaparecer (conta não está mais pendente)');
      assert.equal(depois.cards.saidasRealizadas, 5000, 'TESTE 3 — realizado é o valor do banco, uma vez só');
      const resultado = round2(depois.cards.saidasPrevistas - 0) + depois.cards.saidasRealizadas; // impacto total no período
      assert.equal(resultado, 5000, 'NUNCA -R$10.000 (previsto R$5.000 + realizado R$5.000 somados por engano)');

      await contasBancarias.inativar(c2.id); // ver comentário no TESTE 1 sobre por que inativar
    });
  });

  describe('TESTE 5/10 — tarifa NÃO conciliada continua aparecendo no realizado', () => {
    test('tarifa bancária sem conciliação nenhuma conta como saída realizada (conta isolada, valor exato)', async () => {
      const hoje = hojeBRT();
      const c3 = await criarContaIsolada('Conta T5-10');
      const imp = await criarImportacaoDummy(c3.id);
      await inserirMovimento({ contaBancariaId: c3.id, importacaoId: imp, data: hoje, tipo: 'saida', valor: 49.9, descricao: PREFIXO_TESTE + ' tarifa bancária' });

      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d', contaBancariaId: c3.id });
      assert.equal(f.cards.saidasRealizadas, 49.9, 'movimento não identificado/não conciliado continua sendo dinheiro real, sem depender de status_conciliacao');

      await contasBancarias.inativar(c3.id); // ver comentário no TESTE 1 sobre por que inativar
    });
  });

  describe('TESTE 6 — conta vencida mas não paga: nunca vira "realizada" só porque venceu', () => {
    test('conta com vencimento no passado, ainda pendente, continua PREVISTA (vencida), nunca REALIZADA', async () => {
      // Não cria nenhum movimento bancário — o teste é justamente que
      // NENHUM valor entra em realizado só por a conta estar vencida.
      // Compara o total (consolidado, nível empresa) ANTES e DEPOIS de
      // criar a conta vencida, em vez de assumir um valor absoluto — assim
      // continua correto mesmo que outros testes já tenham movimentos reais
      // na mesma empresa.
      const antes = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      const totalRealizadoSaidasAntes = antes.cards.saidasRealizadas;

      const criada = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ETAPA3, descricao: PREFIXO_TESTE + ' vencida', valor: 777, vencimento: '2026-08-25' });
      assert.equal(criada.errors, undefined);

      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      assert.ok(f.cards.contasVencidas >= 777, 'tem que aparecer como vencida (pendente, com vencimento no passado)');
      assert.equal(f.cards.saidasRealizadas, totalRealizadoSaidasAntes, 'conta vencida e não paga (sem nenhum movimento bancário) nunca pode mudar o realizado');

      await contasPagar.marcarComoPago(criada.conta.id, hojeBRT()); // limpa o estado pra não afetar os próximos testes deste describe
    });
  });

  describe('TESTE 7 — pagamento em data diferente do vencimento: realizado usa a DATA REAL do banco, nunca o vencimento', () => {
    test('conta venceu dia 25, banco mostra pagamento hoje — realizado aparece hoje (conta isolada, valor exato)', async () => {
      const hoje = hojeBRT();
      const c4 = await criarContaIsolada('Conta T7');
      const criada = await contasPagar.criarContaPagar({ empresaId: EMPRESA_ETAPA3, descricao: PREFIXO_TESTE + ' venceu antes, pagou hoje', valor: 300, vencimento: '2026-08-20' });
      const imp = await criarImportacaoDummy(c4.id);
      const movId = await inserirMovimento({ contaBancariaId: c4.id, importacaoId: imp, data: hoje, tipo: 'saida', valor: 300 });
      const conc = await conciliacaoBancaria.confirmarConciliacao({ movimentoId: movId, tipo: 'conta_pagar', alvoId: criada.conta.id });
      assert.equal(conc.errors, undefined);

      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d', contaBancariaId: c4.id });
      const diaHoje = f.serieDiaria.find((d) => d.dia === hoje);
      assert.equal(diaHoje.realizado.saidas, 300, 'tem que aparecer HOJE (data real do banco), nunca no dia 20 (vencimento original, fora até da série de 7 dias)');

      await contasBancarias.inativar(c4.id); // ver comentário no TESTE 1 sobre por que inativar
    });
  });

  describe('TESTE 12 — recebimento de marketplace previsto + depósito no banco, conciliado: nunca soma os dois (prova de não duplicidade #2)', () => {
    test('previsto R$5.000 + banco +R$5.000 conciliado = REALIZADO R$5.000, PREVISTO R$0', async () => {
      const hoje = hojeBRT();
      const c5 = await criarContaIsolada('Conta T12');
      const { rows } = await pool.query(
        `INSERT INTO recebimentos_marketplace (empresa_id, marketplace, referencia_externa, data_venda, valor_bruto, taxas_descontos, valor_liquido_esperado, status)
         VALUES ($1,'Mercado Livre',$2, now(), 5200, 200, 5000, 'a_receber') RETURNING id`,
        [EMPRESA_ETAPA3, PREFIXO_TESTE + '-pedido-975']
      );
      const recebimentoId = rows[0].id;

      const antes = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: 'personalizado', desde: '2026-01-01', ate: hoje, contaBancariaId: c5.id });
      assert.ok(antes.recebimentosMarketplaces.total >= 5000 - 0.01, 'antes: R$5.000 tem que estar em PREVISTO (marketplace)');
      const realizadoAntes = antes.realizadoNoPeriodo.entradas;

      const imp = await criarImportacaoDummy(c5.id);
      const movId = await inserirMovimento({ contaBancariaId: c5.id, importacaoId: imp, data: hoje, tipo: 'entrada', valor: 5000, descricao: PREFIXO_TESTE + ' repasse ML' });
      const conc = await conciliacaoBancaria.confirmarConciliacao({ movimentoId: movId, tipo: 'recebimento_marketplace', alvoId: recebimentoId });
      assert.equal(conc.errors, undefined);
      assert.equal(conc.alvo.status, 'recebido');

      const depois = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: 'personalizado', desde: '2026-01-01', ate: hoje, contaBancariaId: c5.id });
      assert.equal(round2(depois.recebimentosMarketplaces.total), round2(antes.recebimentosMarketplaces.total - 5000), 'depois: previsto cai exatamente R$5.000');
      assert.equal(round2(depois.realizadoNoPeriodo.entradas), round2(realizadoAntes + 5000), 'depois: realizado sobe exatamente R$5.000 — nunca R$10.000');

      await contasBancarias.inativar(c5.id); // ver comentário no TESTE 1 sobre por que inativar
    });
  });

  describe('TESTE 9/10 — saldo por conta e saldo consolidado', () => {
    test('duas contas dedicadas com saldo inicial próprio: consolidado = soma; movimentação posterior atualiza só a conta certa', async () => {
      const hoje = hojeBRT();
      const ontemStr = (() => { const d = new Date(hoje + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();

      // Contas DEDICADAS a este teste (e ao TESTE 11 logo abaixo) — nenhum
      // outro teste deste arquivo cria movimento nelas, então os valores
      // abaixo são exatos por construção, não por sorte de ordem de
      // execução.
      nubank2 = await criarContaIsolada('Nubank (9/10 e 11)');
      mercadoPago2 = await criarContaIsolada('Mercado Pago (9/10 e 11)');

      const s1 = await fluxoCaixa.definirSaldoInicialConta({ empresaId: EMPRESA_ETAPA3, contaBancariaId: nubank2.id, valor: 10000, dataReferencia: ontemStr });
      const s2 = await fluxoCaixa.definirSaldoInicialConta({ empresaId: EMPRESA_ETAPA3, contaBancariaId: mercadoPago2.id, valor: 5000, dataReferencia: ontemStr });
      assert.equal(s1.errors, undefined); assert.equal(s2.errors, undefined);

      const f1 = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      assert.equal(f1.cards.saldoAtual.valor, 15000, 'TESTE 9 — consolidado = 10.000 + 5.000');
      const nubankNoConsolidado = f1.saldosPorConta.find((c) => c.contaBancariaId === nubank2.id);
      assert.equal(nubankNoConsolidado.saldo, 10000);

      // TESTE 10 — movimentação posterior só na conta Nubank.
      const imp = await criarImportacaoDummy(nubank2.id);
      await inserirMovimento({ contaBancariaId: nubank2.id, importacaoId: imp, data: hoje, tipo: 'entrada', valor: 2000 });

      const f2 = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      assert.equal(f2.cards.saldoAtual.valor, 17000, 'TESTE 10 — consolidado = 12.000 (Nubank) + 5.000 (Mercado Pago) = 17.000');
      const nubankDepois = f2.saldosPorConta.find((c) => c.contaBancariaId === nubank2.id);
      const mpDepois = f2.saldosPorConta.find((c) => c.contaBancariaId === mercadoPago2.id);
      assert.equal(nubankDepois.saldo, 12000, 'só o Nubank muda');
      assert.equal(mpDepois.saldo, 5000, 'Mercado Pago fica exatamente igual');

      const fNubankSozinho = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d', contaBancariaId: nubank2.id });
      assert.equal(fNubankSozinho.cards.saldoAtual.valor, 12000, 'consulta por conta bate com o valor "por conta" do consolidado');
    });
  });

  describe('TESTE 11 — transferência interna: consolidado nunca muda, indicadores operacionais não inflam, por conta muda corretamente', () => {
    test('Nubank -R$3.000 / Mercado Pago +R$3.000, classificada como transferência interna', async () => {
      const hoje = hojeBRT();
      assert.ok(nubank2 && mercadoPago2, 'depende do TESTE 9/10 ter rodado antes (mesmas contas dedicadas)');

      const antes = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      const consolidadoAntes = antes.cards.saldoAtual.valor; // 17000, herdado do TESTE 9/10
      const entradasRealizadasAntes = antes.cards.entradasRealizadas;
      const saidasRealizadasAntes = antes.cards.saidasRealizadas;
      const nubankAntes = antes.saldosPorConta.find((c) => c.contaBancariaId === nubank2.id).saldo; // 12000
      const mpAntes = antes.saldosPorConta.find((c) => c.contaBancariaId === mercadoPago2.id).saldo; // 5000

      const impN = await criarImportacaoDummy(nubank2.id);
      const impM = await criarImportacaoDummy(mercadoPago2.id);
      const movOrigem = await inserirMovimento({ contaBancariaId: nubank2.id, importacaoId: impN, data: hoje, tipo: 'saida', valor: 3000, descricao: PREFIXO_TESTE + ' transferência p/ Mercado Pago' });
      const movDestino = await inserirMovimento({ contaBancariaId: mercadoPago2.id, importacaoId: impM, data: hoje, tipo: 'entrada', valor: 3000, descricao: PREFIXO_TESTE + ' transferência de Nubank' });

      // Ainda NÃO classificada: por enquanto conta como entrada/saída normal.
      const semClassificar = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      assert.equal(semClassificar.cards.saidasRealizadas, round2(saidasRealizadasAntes + 3000), 'antes de classificar, ainda conta como saída operacional normal');
      assert.equal(semClassificar.cards.entradasRealizadas, round2(entradasRealizadasAntes + 3000), 'antes de classificar, ainda conta como entrada operacional normal');

      const classif = await fluxoCaixa.classificarComoTransferenciaInterna({ empresaId: EMPRESA_ETAPA3, movimentoOrigemId: movOrigem, movimentoDestinoId: movDestino });
      assert.equal(classif.errors, undefined);

      const depois = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      assert.equal(depois.cards.saldoAtual.valor, consolidadoAntes, 'saldo consolidado NUNCA muda com transferência interna (dinheiro só mudou de conta)');
      assert.equal(depois.cards.entradasRealizadas, entradasRealizadasAntes, 'entradas operacionais não podem inflar com a transferência, depois de classificada');
      assert.equal(depois.cards.saidasRealizadas, saidasRealizadasAntes, 'saídas operacionais não podem inflar com a transferência, depois de classificada');
      assert.equal(depois.cards.transferenciasInternas.entradas, 3000);
      assert.equal(depois.cards.transferenciasInternas.saidas, 3000);

      const nubankPorConta = depois.saldosPorConta.find((c) => c.contaBancariaId === nubank2.id);
      const mpPorConta = depois.saldosPorConta.find((c) => c.contaBancariaId === mercadoPago2.id);
      assert.equal(nubankPorConta.saldo, round2(nubankAntes - 3000), 'Nubank perde exatamente R$3.000 de verdade (o dinheiro saiu da conta)');
      assert.equal(mpPorConta.saldo, round2(mpAntes + 3000), 'Mercado Pago ganha exatamente R$3.000 de verdade (o dinheiro entrou na conta)');
      assert.equal(round2(nubankPorConta.saldo + mpPorConta.saldo), consolidadoAntes, 'a soma das duas contas continua batendo com o consolidado — só mudou de lugar');
    });
  });

  describe('TESTE 13 — sem saldo inicial em nenhuma conta: tela não quebra, saldo "indisponível", resto continua funcionando', () => {
    test('empresa nova, contas sem saldo inicial configurado', async () => {
      const cnNova = await criarContaIsolada('Conta Sem Saldo');
      const hoje = hojeBRT();
      const imp = await criarImportacaoDummy(cnNova.id);
      await inserirMovimento({ contaBancariaId: cnNova.id, importacaoId: imp, data: hoje, tipo: 'entrada', valor: 100 });

      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d', contaBancariaId: cnNova.id });
      assert.equal(f.cards.saldoAtual.valor, null, 'nunca inventa saldo');
      assert.equal(f.cards.saldoAtual.motivo, 'sem_saldo_inicial_informado');
      assert.equal(f.cards.entradasRealizadas, 100, 'entradas/saídas continuam calculáveis mesmo sem saldo inicial');

      await contasBancarias.inativar(cnNova.id); // ver comentário no TESTE 1 sobre por que inativar
    });
  });

  describe('TESTE 14 — data de referência: movimentos anteriores à referência não são somados de novo', () => {
    test('saldo inicial com referência em 2026-08-20 não soma um movimento de 2026-08-15', async () => {
      const contaIsolada = await criarContaIsolada('Conta Referência');
      const imp = await criarImportacaoDummy(contaIsolada.id);
      // movimento ANTES da referência — nunca deve ser somado por cima do saldo inicial
      await inserirMovimento({ contaBancariaId: contaIsolada.id, importacaoId: imp, data: '2026-08-15', tipo: 'entrada', valor: 99999 });
      // movimento NO PRÓPRIO dia de referência — já embutido no saldo informado, mas a soma inclui a partir dele (ver comentário de saldoContaEm)
      await inserirMovimento({ contaBancariaId: contaIsolada.id, importacaoId: imp, data: '2026-08-20', tipo: 'entrada', valor: 100 });
      // movimento depois da referência
      await inserirMovimento({ contaBancariaId: contaIsolada.id, importacaoId: imp, data: '2026-08-21', tipo: 'saida', valor: 30 });

      await fluxoCaixa.definirSaldoInicialConta({ empresaId: EMPRESA_ETAPA3, contaBancariaId: contaIsolada.id, valor: 1000, dataReferencia: '2026-08-20' });

      const saldoInicial = await fluxoCaixa.buscarSaldoInicialConta(contaIsolada.id);
      const saldoEm22 = await fluxoCaixa.saldoContaEm(contaIsolada.id, saldoInicial, '2026-08-22');
      // 1000 (inicial) + 100 (dia 20, incluso) - 30 (dia 21) = 1070 — NUNCA soma o movimento de 99999 do dia 15 (antes da referência)
      assert.equal(saldoEm22, 1070, 'nunca soma o movimento anterior à referência (99999), soma o do próprio dia de referência em diante uma única vez');

      await contasBancarias.inativar(contaIsolada.id); // ver comentário no TESTE 1 sobre por que inativar
    });
  });

  describe('Saldo inicial LEGADO (empresa) nunca vaza pra fórmula nova', () => {
    test('definir o saldo legado (só empresa) não afeta gerarFluxoDeCaixa depois que os saldos por conta existem', async () => {
      const hoje = hojeBRT();
      await fluxoCaixa.definirSaldoInicial({ empresaId: EMPRESA_ETAPA3, valor: 999999, dataReferencia: hoje });
      const f = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId: EMPRESA_ETAPA3, periodoChave: '7d' });
      assert.notEqual(f.cards.saldoAtual.valor, 999999, 'o valor legado nunca pode aparecer no saldo consolidado novo');
      assert.equal(f.cards.saldoAtual.valor, 17000, 'consolidado continua vindo só da soma por conta (17.000, do TESTE 9/10 e 11 acima — a transferência não muda o total)');
    });
  });
});
