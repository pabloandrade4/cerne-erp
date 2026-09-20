// Especialista "Anúncios" para a Daily dos Agentes (19/09/2026, pedido
// explícito do usuário: "quero que essas ia nunca pare de trabalhar... e
// quero que os relatórios... me envie tudo no whatsapp"). Mesmo conceito de
// especialistaAds.js/especialistaPromocoes.js: reaproveita EXCLUSIVAMENTE o
// que o Radar da IA já persistiu (radar_alertas, ver lib/ia/radarAnuncios.js)
// — nunca recalcula nada aqui. Só entram os alertas de ANÚNCIO
// (`anuncio_%`, ver lib/ia/radarAnuncios.js) — os alertas financeiros/de
// negócio do mesmo Radar (lib/ia/radarNegocio.js) ficam de fora, mesmo
// limite já definido pelo usuário pro setor "Anúncios" da Sala dos Agentes
// ("Radar só pode aparecer como 'Anúncios' se for só anúncio").
const pool = require('../../db/pool');

const AGENTE_CODIGO = 'anuncios_radar';

const SEVERIDADE_PARA_ACHADO = {
  critico: { tipo: 'problema', prioridade: 'alta' },
  atencao: { tipo: 'problema', prioridade: 'media' },
  oportunidade: { tipo: 'oportunidade', prioridade: 'baixa' },
  informativo: { tipo: 'risco', prioridade: 'baixa' },
};

async function achadosDeAlertasAbertos(empresaId) {
  const { rows } = await pool.query(
    `SELECT id, severidade, titulo, descricao, dados FROM radar_alertas
      WHERE empresa_id = $1 AND categoria LIKE 'anuncio_%' AND status = 'aberto'
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
