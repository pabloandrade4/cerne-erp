// Especialistas "SAC Mercado Livre" e "SAC Shopee" na Daily dos Agentes
// (20/09/2026, pedido explícito do usuário — SAC tinha ficado de fora da
// Etapa 4 por decisão combinada de deixar pra uma próxima etapa; esta é essa
// etapa). Testes de INTEGRAÇÃO — cada especialista só LÊ
// sac_atendimentos/sac_respostas (nunca recalcula/gera sugestão nova aqui),
// então basta inserir/limpar linhas reais pra testar. Mesmo padrão de
// test/especialistaAnunciosEConcorrente.test.js.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 984;

describe(
  'especialistaSacMercadoLivre / especialistaSacShopee — Daily dos Agentes só lê o que já foi persistido (20/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, especialistaMl, especialistaShopee;

    before(async () => {
      pool = require('../db/pool');
      especialistaMl = require('../lib/ia/especialistaSacMercadoLivre');
      especialistaShopee = require('../lib/ia/especialistaSacShopee');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '98400984000199', 'EMPRESA TESTE ESPECIALISTA SAC', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
    });

    afterEach(async () => {
      await pool.query('DELETE FROM sac_atendimentos WHERE empresa_id = $1', [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
    });

    async function criarAtendimento({ marketplace, tipoOrigem, urgente, classificacao, idExterno, mensagem, statusDecisao }) {
      const { rows } = await pool.query(
        `INSERT INTO sac_atendimentos
           (empresa_id, marketplace, conta_id, tipo_origem, id_externo, sku, produto_titulo,
            cliente_nome, mensagem_cliente, data_recebido, urgente, classificacao)
         VALUES ($1,$2,999,$3,$4,'SKU-984','Caixa Teste 984','Cliente Teste',$5, now(), $6, $7)
         RETURNING id`,
        [EMPRESA_ID, marketplace, tipoOrigem, idExterno, mensagem || 'Mensagem real do cliente.', !!urgente, classificacao || null]
      );
      const atendimentoId = rows[0].id;
      await pool.query(
        `INSERT INTO sac_respostas (atendimento_id, resposta_sugerida_ia, status_decisao)
         VALUES ($1, 'Resposta sugerida pela IA.', $2)`,
        [atendimentoId, statusDecisao || 'pendente']
      );
      return atendimentoId;
    }

    test('AGENTE_CODIGO bate com o codigo cadastrado em ia_agentes (senão a Daily quebra por causa da FK)', async () => {
      const { rows } = await pool.query('SELECT codigo FROM ia_agentes WHERE codigo = ANY($1)', [
        [especialistaMl.AGENTE_CODIGO, especialistaShopee.AGENTE_CODIGO],
      ]);
      const codigos = rows.map((r) => r.codigo).sort();
      assert.deepEqual(codigos, [especialistaMl.AGENTE_CODIGO, especialistaShopee.AGENTE_CODIGO].sort());
    });

    test('sem sugestão pendente -> nenhum achado (nunca inventa)', async () => {
      const { achados } = await especialistaMl.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.deepEqual(achados, []);
    });

    test('atendimento urgente vira achado tipo "problema" prioridade "alta", mesmo sem classificação', async () => {
      await criarAtendimento({ marketplace: 'mercado_livre', tipoOrigem: 'reclamacao', urgente: true, idExterno: 'claim-1' });
      const { achados } = await especialistaMl.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].tipo, 'problema');
      assert.equal(achados[0].prioridade, 'alta');
      assert.match(achados[0].titulo, /Reclamação/);
    });

    test('pergunta pré-venda simples (não urgente, sem classificação de problema) vira "risco" prioridade "baixa"', async () => {
      await criarAtendimento({ marketplace: 'mercado_livre', tipoOrigem: 'pergunta', urgente: false, idExterno: 'question-1' });
      const { achados } = await especialistaMl.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].tipo, 'risco');
      assert.equal(achados[0].prioridade, 'baixa');
    });

    test('classificacao "insatisfeito" sem a flag urgente ainda vira "problema" prioridade "media"', async () => {
      await criarAtendimento({ marketplace: 'mercado_livre', tipoOrigem: 'mensagem', urgente: false, classificacao: 'insatisfeito', idExterno: 'msg-1' });
      const { achados } = await especialistaMl.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.equal(achados.length, 1);
      assert.equal(achados[0].tipo, 'problema');
      assert.equal(achados[0].prioridade, 'media');
    });

    test('isolamento por marketplace: sugestão da Shopee nunca aparece pro especialista do Mercado Livre, e vice-versa', async () => {
      await criarAtendimento({ marketplace: 'shopee', tipoOrigem: 'pergunta', idExterno: 'shopee-1' });
      const [ml, shopee] = await Promise.all([
        especialistaMl.gerarResumoDiario({ empresaId: EMPRESA_ID }),
        especialistaShopee.gerarResumoDiario({ empresaId: EMPRESA_ID }),
      ]);
      assert.deepEqual(ml.achados, []);
      assert.equal(shopee.achados.length, 1);
    });

    test('sugestão já decidida (status_decisao <> pendente) nunca aparece como achado pendente', async () => {
      await criarAtendimento({ marketplace: 'mercado_livre', tipoOrigem: 'pergunta', idExterno: 'question-decidida', statusDecisao: 'aprovada' });
      const { achados } = await especialistaMl.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.deepEqual(achados, []);
    });

    test('decisaoTabela/decisaoId apontam pra sac_respostas — permite aprovar/recusar de verdade a partir do achado', async () => {
      const atendimentoId = await criarAtendimento({ marketplace: 'mercado_livre', tipoOrigem: 'pergunta', idExterno: 'question-decisao' });
      const { achados } = await especialistaMl.gerarResumoDiario({ empresaId: EMPRESA_ID });
      assert.equal(achados[0].decisaoTabela, 'sac_respostas');
      const { rows } = await pool.query('SELECT atendimento_id FROM sac_respostas WHERE id = $1', [achados[0].decisaoId]);
      assert.equal(rows[0].atendimento_id, atendimentoId);
    });
  }
);
