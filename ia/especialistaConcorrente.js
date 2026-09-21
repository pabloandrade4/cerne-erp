// Especialista "Análise de Concorrente" para a Daily dos Agentes (19/09/2026,
// pedido explícito do usuário: "quero que essas ia nunca pare de
// trabalhar... e quero que os relatórios... me envie tudo no whatsapp").
// Mesmo conceito de especialistaAds.js/especialistaPromocoes.js: reaproveita
// EXCLUSIVAMENTE o que o agente automático já persistiu (radar_alertas,
// categoria 'concorrente_ativo', ver lib/ia/radarConcorrente.js) — nunca
// busca de novo na API do Mercado Livre aqui (isso já rodou no ciclo
// próprio, 1x por dia — ver lib/ia/concorrenteScheduler.js). Sem alerta
// aberto real, sem achado.
const pool = require('../../db/pool');

const AGENTE_CODIGO = 'concorrente';

// Achado de Concorrente nunca tem uma decisão "aprovar/recusar" própria
// (é só observação, ver lib/ia/radarConcorrente.js) — por isso 'risco'
// (situação a observar) em vez de 'problema' pros casos de menor confiança,
// e 'oportunidade' quando você já está competitivo.
const SEVERIDADE_PARA_ACHADO = {
  critico: { tipo: 'problema', prioridade: 'alta' },
  atencao: { tipo: 'problema', prioridade: 'media' },
  informativo: { tipo: 'risco', prioridade: 'baixa' },
  oportunidade: { tipo: 'oportunidade', prioridade: 'baixa' },
};

async function achadosDeAlertasAbertos(empresaId) {
  const { rows } = await pool.query(
    `SELECT id, severidade, titulo, descricao, dados FROM radar_alertas
      WHERE empresa_id = $1 AND categoria = 'concorrente_ativo' AND status = 'aberto'
      ORDER BY CASE severidade WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 WHEN 'informativo' THEN 2 ELSE 3 END, atualizado_em DESC`,
    [empresaId]
  );
  return rows.map((r) => {
    const mapa = SEVERIDADE_PARA_ACHADO[r.severidade] || { tipo: 'risco', prioridade: 'baixa' };
    return {
      tipo: mapa.tipo,
      titulo: r.titulo,
      descricao: r.descricao,
      dados: r.dados,
      prioridade: mapa.prioridade,
      sku: (r.dados && r.dados.sku) || null,
      campanhaId: null,
      pedidoId: null,
      decisaoTabela: null, // achado informativo — sem fluxo de aprovar/recusar próprio
      decisaoId: null,
    };
  });
}

async function gerarResumoDiario({ empresaId }) {
  const achados = await achadosDeAlertasAbertos(empresaId);
  return { achados };
}

module.exports = { AGENTE_CODIGO, gerarResumoDiario };
