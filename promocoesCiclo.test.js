// IA de Promoções — Fase B — testes de INTEGRAÇÃO (precisa de Postgres
// local — mesma regra de skip por DATABASE_URL dos outros arquivos desta
// pasta, ver test/radar.test.js). Cobre o contrato de resiliência do ciclo
// automático (lib/ia/promocoesCiclo.js), disparando-o como uma função Node
// comum — exatamente como lib/ia/promocoesScheduler.js dispara sozinho, sem
// depender de nenhuma aba aberta:
//   1) empresa inexistente/inativa é ignorada, nunca derruba o ciclo;
//   2) empresa sem nenhuma conta ativa simplesmente não analisa nada (não é
//      erro);
//   3) uma conta com token inválido (não dá pra chamar a API do Mercado
//      Livre de verdade) faz o ciclo registrar o erro DAQUELA conta e
//      seguir — nunca lança exceção pra fora nem derruba o processo. Esta
//      suíte não chama a API real do Mercado Livre (mesma decisão já usada
//      em test/radar.test.js para a API de Ads: token fabricado, sem
//      credencial válida).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 971;
const EMPRESA_SEM_CONTA_ID = 972;
const CONTA_ML_ID = 971;

describe(
  'IA de Promoções — ciclo automático (Fase B): resiliência por empresa/conta',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool;
    let executarCicloPromocoesEmpresa;

    before(async () => {
      pool = require('../db/pool');
      ({ executarCicloPromocoesEmpresa } = require('../lib/ia/promocoesCiclo'));

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
           ($1, '97170707000199', 'EMPRESA TESTE PROMOÇÕES', TRUE),
           ($2, '97270707000199', 'EMPRESA TESTE PROMOÇÕES SEM CONTA', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID, EMPRESA_SEM_CONTA_ID]
      );
      // Token fabricado (não é um access_token real do Mercado Livre) —
      // qualquer chamada à API vai falhar com erro de autenticação, o que é
      // exatamente o cenário que este teste quer confirmar que o ciclo
      // sabe absorver sem derrubar o processo.
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 971000001, 'LOJA TESTE PROMOÇÕES', 'token-invalido', 'refresh-invalido', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status = 'ativa'`,
        [CONTA_ML_ID, EMPRESA_ID]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM promocoes_analises WHERE empresa_id = ANY($1::int[])', [[EMPRESA_ID, EMPRESA_SEM_CONTA_ID]]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1::int[])', [[EMPRESA_ID, EMPRESA_SEM_CONTA_ID]]);
    });

    test('empresa inexistente: devolve ignorado, nunca lança exceção', async () => {
      const resultado = await executarCicloPromocoesEmpresa(999999);
      assert.equal(resultado.ignorado, true);
    });

    test('empresa ativa sem nenhuma conta do Mercado Livre: não analisa nada, não é erro', async () => {
      const resultado = await executarCicloPromocoesEmpresa(EMPRESA_SEM_CONTA_ID);
      assert.equal(resultado.contasProcessadas, 0);
      assert.equal(resultado.itensAnalisados, 0);
    });

    test('conta com token inválido: o ciclo termina normalmente e registra o erro DAQUELA conta', async () => {
      const resultado = await executarCicloPromocoesEmpresa(EMPRESA_ID);
      assert.equal(resultado.contasProcessadas, 1);
      assert.equal(resultado.itensAnalisados, 0);
      assert.equal(resultado.comErro.length, 1);
      assert.equal(resultado.comErro[0].contaId, CONTA_ML_ID);
      assert.ok(resultado.comErro[0].erro && resultado.comErro[0].erro.length > 0);
    });
  }
);
