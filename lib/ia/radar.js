// Radar da IA — orquestrador (Passo 3 do pedido do usuário, ver
// docs/02-decisoes.md): junta as regras/cálculos determinísticos
// (lib/ia/radarAnuncios.js + lib/ia/radarNegocio.js), persiste o resultado
// (nunca duplica um alerta que já existe — atualiza), e SÓ ENTÃO, e só para
// situações NOVAS ou que pioraram de severidade, usa a IA para escrever uma
// recomendação melhor (nunca chama o modelo à toa a cada ciclo — pedido
// explícito do usuário). Quem dispara este arquivo periodicamente é
// lib/ia/radarScheduler.js (sempre no servidor, nunca um timer do
// navegador).
const pool = require('../../db/pool');
const { analisarAnuncios, listarAdsSeguro } = require('./radarAnuncios');
const { analisarNegocio } = require('./radarNegocio');
const { obterProvedorConfigurado } = require('./providers');

const SEVERIDADE_ORDEM = { critico: 0, atencao: 1, oportunidade: 2, informativo: 3 };
const SEVERIDADE_LABEL = { critico: 'Crítico', atencao: 'Atenção', oportunidade: 'Oportunidade', informativo: 'Informativo' };
const SEVERIDADE_EMOJI = { critico: '🔴', atencao: '🟠', oportunidade: '🟢', informativo: '🔵' };

// CORREÇÃO (01/09/2026, ativação da Central de Alertas — Etapa 7 pedida
// pelo usuário — ver docs/04-alteracoes.md): o usuário pediu a tela
// organizada por "Prioridade (Crítico/Alto/Médio/Baixo)". Reaproveita a
// MESMA severidade que já existe (nunca cria uma coluna nova no banco nem
// recalcula nada) — só mapeia o rótulo pra vocabulário de prioridade:
// critico->Crítico (mesma coisa), atencao->Alto, informativo->Médio,
// oportunidade->Baixo (sugestão de crescimento, nunca um problema urgente).
const PRIORIDADE_POR_SEVERIDADE = { critico: 'critico', atencao: 'alto', informativo: 'medio', oportunidade: 'baixo' };
const PRIORIDADE_LABEL = { critico: 'Crítico', alto: 'Alto', medio: 'Médio', baixo: 'Baixo' };

// Status da Central de Alertas (Novo/Visualizado/Resolvido/Ignorado,
// pedido explícito do usuário) — reaproveita a MESMA coluna `status` que já
// existia ('aberto'/'resolvido', ver db/schema.sql), só adicionando
// 'ignorado' como 3º valor possível (retrofit) e derivando Novo x
// Visualizado a partir de `visualizado_em` (NULL = Novo) dentro de um
// status='aberto' — nunca uma coluna paralela guardando a mesma informação
// de dois jeitos.
function statusCentralDoRegistro(row) {
  if (row.status === 'resolvido') return 'resolvido';
  if (row.status === 'ignorado') return 'ignorado';
  return row.visualizado_em ? 'visualizado' : 'novo';
}
const STATUS_CENTRAL_LABEL = { novo: 'Novo', visualizado: 'Visualizado', resolvido: 'Resolvido', ignorado: 'Ignorado' };

function formatMoney(v) {
  if (v === null || v === undefined) return null;
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------- Persistência (upsert por chave, nunca duplica) ----------------
// Devolve as situações que são NOVAS ou que pioraram de severidade desde o
// último ciclo — é só essa lista, tipicamente pequena, que pode gerar uma
// chamada à IA (ver interpretarComIA abaixo).
async function persistirSituacoes(empresaId, situacoes) {
  const client = await pool.connect();
  const novasOuEscaladas = [];
  try {
    await client.query('BEGIN');

    for (const s of situacoes) {
      const { rows } = await client.query(
        'SELECT id, severidade, status FROM radar_alertas WHERE empresa_id = $1 AND chave = $2',
        [empresaId, s.chave]
      );
      const existente = rows[0];
      const dadosJson = JSON.stringify(s.dados || {});

      if (!existente) {
        const ins = await client.query(
          `INSERT INTO radar_alertas (empresa_id, chave, categoria, severidade, titulo, descricao, recomendacao, dados, pagina, status, ultima_deteccao_em, atualizado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'aberto', now(), now()) RETURNING id`,
          [empresaId, s.chave, s.categoria, s.severidade, s.titulo, s.descricao, s.recomendacaoPadrao, dadosJson, s.pagina || null]
        );
        novasOuEscaladas.push({ ...s, id: ins.rows[0].id });
        continue;
      }

      // CORREÇÃO (01/09/2026, ativação da Central de Alertas — ver
      // docs/04-alteracoes.md): reabre (`status='aberto'`) quando o alerta
      // tinha sido resolvido/ficou pior — nunca quando o usuário marcou
      // manualmente como 'ignorado' (novo status, ver ALTER TABLE em
      // db/schema.sql) e a situação continua igual ou melhorou: sem este
      // `existente.status === 'ignorado'` explícito, o UPDATE do "else"
      // abaixo forçava `status='aberto'` TODO ciclo (a cada 15min),
      // desfazendo silenciosamente a escolha do usuário de ignorar aquele
      // alerta. Se a severidade PIORAR, ainda assim reabre mesmo estando
      // ignorado — nunca deixa um problema que piorou escondido.
      const estavaIgnorado = existente.status === 'ignorado';
      const piorou = existente.status === 'resolvido' || SEVERIDADE_ORDEM[s.severidade] < SEVERIDADE_ORDEM[existente.severidade];
      if (piorou) {
        // Severidade piorou (ou o alerta tinha sido resolvido/ignorado e
        // voltou a acontecer/piorou) — reseta a recomendação pro texto
        // padrão da situação atual; este item entra na lista pra IA
        // reinterpretar.
        await client.query(
          `UPDATE radar_alertas SET categoria=$3, severidade=$4, titulo=$5, descricao=$6, recomendacao=$7, dados=$8, pagina=$9,
             status='aberto', atualizado_em=now(), ultima_deteccao_em=now(), resolvido_em=NULL, ignorado_em=NULL
           WHERE empresa_id = $1 AND chave = $2`,
          [empresaId, s.chave, s.categoria, s.severidade, s.titulo, s.descricao, s.recomendacaoPadrao, dadosJson, s.pagina || null]
        );
        novasOuEscaladas.push({ ...s, id: existente.id });
      } else if (estavaIgnorado) {
        // Continua a mesma situação, mesma severidade (ou melhor), e o
        // usuário tinha marcado como ignorado — atualiza só os números/
        // textos determinísticos, NUNCA o status (respeita a escolha do
        // usuário até ele mesmo mudar ou a severidade piorar).
        await client.query(
          `UPDATE radar_alertas SET categoria=$3, severidade=$4, titulo=$5, descricao=$6, dados=$7, pagina=$8,
             ultima_deteccao_em=now()
           WHERE empresa_id = $1 AND chave = $2`,
          [empresaId, s.chave, s.categoria, s.severidade, s.titulo, s.descricao, dadosJson, s.pagina || null]
        );
      } else {
        // Mesma situação, mesma severidade (ou melhor) — atualiza só os
        // números/textos determinísticos, preservando a recomendação já
        // escrita (possivelmente já enriquecida pela IA num ciclo anterior)
        // — nunca reescreve nem chama o modelo de novo à toa.
        await client.query(
          `UPDATE radar_alertas SET categoria=$3, severidade=$4, titulo=$5, descricao=$6, dados=$7, pagina=$8,
             status='aberto', atualizado_em=now(), ultima_deteccao_em=now(), resolvido_em=NULL
           WHERE empresa_id = $1 AND chave = $2`,
          [empresaId, s.chave, s.categoria, s.severidade, s.titulo, s.descricao, dadosJson, s.pagina || null]
        );
      }
    }

    // Qualquer alerta ABERTO que não foi detectado neste ciclo já deixou de
    // ser verdade — resolve automaticamente (nunca precisa ação manual pra
    // "limpar" algo que já não existe mais).
    const chavesDetectadas = situacoes.map((s) => s.chave);
    if (chavesDetectadas.length) {
      await client.query(
        `UPDATE radar_alertas SET status='resolvido', resolvido_em=now()
         WHERE empresa_id = $1 AND status = 'aberto' AND NOT (chave = ANY($2::text[]))`,
        [empresaId, chavesDetectadas]
      );
    } else {
      await client.query(
        `UPDATE radar_alertas SET status='resolvido', resolvido_em=now() WHERE empresa_id = $1 AND status = 'aberto'`,
        [empresaId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return novasOuEscaladas;
}

// ---------------- Interpretação pela IA (só para o que é novo/piorou) ----------------
// UMA chamada ao provedor cobrindo TODAS as situações novas/escaladas deste
// ciclo (nunca uma chamada por situação) — e só quando existe pelo menos
// uma. Formato de resposta simples e tolerante a falha: se o modelo não
// responder no formato esperado, ou a chamada falhar por qualquer motivo
// (sem chave configurada, rede, limite), cada alerta mantém a
// `recomendacaoPadrao` (determinística) já gravada — a interpretação da IA
// é sempre um enriquecimento opcional, nunca uma dependência para o Radar
// funcionar.
async function interpretarComIA({ empresa, itens }) {
  if (!itens.length) return;
  const provedor = obterProvedorConfigurado();
  if (provedor.erro) return; // sem IA configurada — os alertas já têm a recomendação padrão

  const lista = itens.map((it, i) => `${i + 1}) [${it.categoria}] ${it.titulo}\n${it.descricao}`).join('\n\n');
  const system = 'Você é a IA Gestora de um ERP de e-commerce, escrevendo recomendações curtas (1 a 2 frases) em português do Brasil para situações já detectadas por regras determinísticas do sistema — os números já estão corretos, sua única tarefa é interpretar e recomendar uma ação para o dono do negócio avaliar. Nunca invente números novos, nunca recomende que a IA execute a ação sozinha (ela só analisa e recomenda). Responda EXATAMENTE no formato "N) texto da recomendação", uma linha por item, na mesma ordem e quantidade dos itens recebidos, sem nenhum texto antes ou depois.';
  try {
    const resultado = await provedor.enviarMensagem({
      system,
      mensagens: [{ role: 'user', content: `Empresa: ${empresa.nome}. Situações detectadas:\n\n${lista}` }],
      ferramentas: [],
      maxTokens: 800,
    });
    const texto = (resultado.conteudo || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const porNumero = new Map();
    texto.split('\n').forEach((linha) => {
      const m = linha.match(/^\s*(\d+)\)\s*(.+)$/);
      if (m) porNumero.set(Number(m[1]), m[2].trim());
    });
    for (let i = 0; i < itens.length; i++) {
      const recomendacao = porNumero.get(i + 1);
      if (recomendacao) itens[i].recomendacaoIA = recomendacao;
    }
  } catch (err) {
    console.error('[radar da ia] falha ao interpretar com IA (alertas continuam com a recomendação padrão): ' + (err && err.message));
  }
}

async function aplicarRecomendacoesIA(empresaId, itens) {
  for (const it of itens) {
    if (!it.recomendacaoIA) continue;
    await pool.query(
      'UPDATE radar_alertas SET recomendacao = $3, interpretado_em = now() WHERE empresa_id = $1 AND chave = $2',
      [empresaId, it.chave, it.recomendacaoIA]
    );
  }
}

// ---------------- "O que precisa da minha atenção hoje" ----------------
// Puramente uma SELEÇÃO/formatação do que já foi determinado (nunca uma
// nova chamada à IA aqui) — os top alertas abertos, priorizando severidade
// e depois o valor em dinheiro envolvido, no formato pedido pelo usuário: o
// que aconteceu, quanto dinheiro está envolvido, por que importa, o que a
// IA recomenda.
async function gerarResumoHoje(empresaId) {
  const { rows } = await pool.query(
    `SELECT categoria, severidade, titulo, descricao, recomendacao, dados, pagina FROM radar_alertas
     WHERE empresa_id = $1 AND status = 'aberto' AND severidade IN ('critico','atencao','oportunidade')`,
    [empresaId]
  );
  const comValor = rows.map((r) => ({ ...r, dados: r.dados })).sort((a, b) => {
    const ordA = SEVERIDADE_ORDEM[a.severidade], ordB = SEVERIDADE_ORDEM[b.severidade];
    if (ordA !== ordB) return ordA - ordB;
    const va = Math.abs(Number((a.dados && a.dados.valorEnvolvido) || 0));
    const vb = Math.abs(Number((b.dados && b.dados.valorEnvolvido) || 0));
    return vb - va;
  });
  const top = comValor.slice(0, 5).map((r) => ({
    emoji: SEVERIDADE_EMOJI[r.severidade], severidade: r.severidade, severidadeLabel: SEVERIDADE_LABEL[r.severidade],
    titulo: r.titulo, oQueAconteceu: r.descricao, oQueRecomenda: r.recomendacao, pagina: r.pagina,
  }));
  return top;
}

// ---------------- Ciclo completo de uma empresa ----------------
async function executarCicloRadarEmpresa(empresaId) {
  const empresaRow = await pool.query('SELECT id, razao_social, nome_fantasia FROM empresas WHERE id = $1 AND ativo = TRUE', [empresaId]);
  if (!empresaRow.rows.length) return { empresaId, ignorado: true };
  const empresa = { id: empresaRow.rows[0].id, nome: empresaRow.rows[0].nome_fantasia || empresaRow.rows[0].razao_social };

  const agora = new Date();
  const [adsResultado30, adsResultado7] = await Promise.all([
    listarAdsSeguro({ empresaId, dias: 30, agora }),
    listarAdsSeguro({ empresaId, dias: 7, agora }),
  ]);

  const [situacoesAnuncios, situacoesNegocio] = await Promise.all([
    analisarAnuncios({ empresaId, adsResultado30, adsResultado7 }),
    analisarNegocio({ empresaId, adsResultado30 }),
  ]);
  const situacoes = [...situacoesAnuncios, ...situacoesNegocio];

  const novasOuEscaladas = await persistirSituacoes(empresaId, situacoes);
  await interpretarComIA({ empresa, itens: novasOuEscaladas });
  await aplicarRecomendacoesIA(empresaId, novasOuEscaladas);

  const resumoHoje = await gerarResumoHoje(empresaId);
  const { rows: abertosCount } = await pool.query(`SELECT count(*)::int AS total FROM radar_alertas WHERE empresa_id = $1 AND status = 'aberto'`, [empresaId]);

  await pool.query(
    `INSERT INTO radar_estado (empresa_id, ultima_execucao_em, ultima_execucao_ok, ultimo_erro, situacoes_abertas, resumo_hoje, resumo_gerado_em)
     VALUES ($1, now(), TRUE, NULL, $2, $3, now())
     ON CONFLICT (empresa_id) DO UPDATE SET ultima_execucao_em = now(), ultima_execucao_ok = TRUE, ultimo_erro = NULL,
       situacoes_abertas = EXCLUDED.situacoes_abertas, resumo_hoje = EXCLUDED.resumo_hoje, resumo_gerado_em = now()`,
    [empresaId, abertosCount[0].total, JSON.stringify(resumoHoje)]
  );

  return { empresaId, situacoesDetectadas: situacoes.length, novasOuEscaladas: novasOuEscaladas.length, situacoesAbertas: abertosCount[0].total };
}

// Roda o ciclo para TODAS as empresas ativas — cada uma isolada
// (Promise.allSettled, mesmo padrão de lib/syncScheduler.js): uma empresa
// falhando nunca impede as demais nem os próximos ciclos.
async function executarCicloRadar() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloRadarEmpresa(e.id)));

  const comErro = [];
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      const empresaId = empresas[i].id;
      comErro.push({ empresaId, erro: String((r.reason && r.reason.message) || r.reason) });
      console.error(`[radar da ia] empresa ${empresaId} falhou: ${comErro[comErro.length - 1].erro}`);
      pool.query(
        `INSERT INTO radar_estado (empresa_id, ultima_execucao_em, ultima_execucao_ok, ultimo_erro)
         VALUES ($1, now(), FALSE, $2)
         ON CONFLICT (empresa_id) DO UPDATE SET ultima_execucao_em = now(), ultima_execucao_ok = FALSE, ultimo_erro = $2`,
        [empresaId, comErro[comErro.length - 1].erro]
      ).catch(() => {});
    }
  });

  return { empresasProcessadas: empresas.length, comErro };
}

// ---------------- Leitura (usada por lib/visaoGeralPainel.js e routes/iaGestora.js) ----------------
// Só SELECT — nunca dispara um ciclo/cálculo aqui (o cálculo acontece só no
// ciclo periódico, ver radarScheduler.js). Rápido o suficiente para ser
// chamado a cada carregamento de tela.
async function obterRadarParaEmpresa(empresaId) {
  const [{ rows: alertas }, { rows: estadoRows }] = await Promise.all([
    pool.query(
      `SELECT id, categoria, severidade, titulo, descricao, recomendacao, dados, pagina, criado_em, atualizado_em
       FROM radar_alertas WHERE empresa_id = $1 AND status = 'aberto'
       ORDER BY CASE severidade WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 WHEN 'oportunidade' THEN 2 ELSE 3 END, atualizado_em DESC`,
      [empresaId]
    ),
    pool.query('SELECT ultima_execucao_em, ultima_execucao_ok, situacoes_abertas, resumo_hoje, resumo_gerado_em FROM radar_estado WHERE empresa_id = $1', [empresaId]),
  ]);

  const porSeveridade = { critico: [], atencao: [], oportunidade: [], informativo: [] };
  alertas.forEach((a) => {
    if (porSeveridade[a.severidade]) porSeveridade[a.severidade].push(a);
  });

  const estado = estadoRows[0] || null;
  return {
    alertas,
    porSeveridade,
    contagem: {
      critico: porSeveridade.critico.length, atencao: porSeveridade.atencao.length,
      oportunidade: porSeveridade.oportunidade.length, informativo: porSeveridade.informativo.length,
      total: alertas.length,
    },
    resumoHoje: estado ? (estado.resumo_hoje || []) : [],
    ultimaExecucaoEm: estado ? estado.ultima_execucao_em : null,
    ultimaExecucaoOk: estado ? estado.ultima_execucao_ok : null,
  };
}

// ---------------- Central de Alertas (Etapa 7, 01/09/2026) ----------------
// Diferente de obterRadarParaEmpresa (só 'aberto', usado pelos painéis
// resumidos de Visão Geral/IA Gestora): aqui lê TODOS os status (a tela
// precisa mostrar Resolvido/Ignorado também, pra quem quiser conferir o
// histórico), com filtro opcional por prioridade/status/categoria — nunca
// dispara um ciclo novo, só SELECT no que o Radar (periódico, em segundo
// plano) já persistiu.
async function listarAlertasCentral(empresaId, { prioridade, status, categoria } = {}) {
  const where = ['empresa_id = $1'];
  const params = [empresaId];
  if (categoria) { params.push(categoria); where.push(`categoria = $${params.length}`); }
  if (prioridade) {
    const severidades = Object.keys(PRIORIDADE_POR_SEVERIDADE).filter((sev) => PRIORIDADE_POR_SEVERIDADE[sev] === prioridade);
    if (severidades.length) { params.push(severidades); where.push(`severidade = ANY($${params.length}::text[])`); }
  }
  const { rows } = await pool.query(
    `SELECT id, categoria, severidade, titulo, descricao, recomendacao, dados, pagina, status, visualizado_em, ignorado_em, criado_em, atualizado_em, resolvido_em
     FROM radar_alertas WHERE ${where.join(' AND ')}
     ORDER BY CASE severidade WHEN 'critico' THEN 0 WHEN 'atencao' THEN 1 WHEN 'informativo' THEN 2 ELSE 3 END, atualizado_em DESC`,
    params
  );
  const mapeados = rows.map((r) => ({
    id: r.id,
    categoria: r.categoria,
    severidade: r.severidade,
    prioridade: PRIORIDADE_POR_SEVERIDADE[r.severidade] || 'baixo',
    prioridadeLabel: PRIORIDADE_LABEL[PRIORIDADE_POR_SEVERIDADE[r.severidade]] || 'Baixo',
    titulo: r.titulo,
    descricao: r.descricao,
    recomendacao: r.recomendacao,
    valorEnvolvido: (r.dados && r.dados.valorEnvolvido !== undefined) ? r.dados.valorEnvolvido : null,
    dados: r.dados,
    pagina: r.pagina,
    statusCentral: statusCentralDoRegistro(r),
    statusCentralLabel: STATUS_CENTRAL_LABEL[statusCentralDoRegistro(r)],
    criadoEm: r.criado_em,
    atualizadoEm: r.atualizado_em,
    resolvidoEm: r.resolvido_em,
    visualizadoEm: r.visualizado_em,
    ignoradoEm: r.ignorado_em,
  }));
  // Filtro por status central é feito aqui (não em SQL): 'novo'/'visualizado'
  // são derivados de visualizado_em, não uma coluna própria pra filtrar.
  const filtrados = status ? mapeados.filter((a) => a.statusCentral === status) : mapeados;
  return {
    alertas: filtrados,
    contagemPorPrioridade: mapeados.reduce((acc, a) => { acc[a.prioridade] = (acc[a.prioridade] || 0) + 1; return acc; }, { critico: 0, alto: 0, medio: 0, baixo: 0 }),
    contagemPorStatus: mapeados.reduce((acc, a) => { acc[a.statusCentral] = (acc[a.statusCentral] || 0) + 1; return acc; }, { novo: 0, visualizado: 0, resolvido: 0, ignorado: 0 }),
  };
}

// Ações manuais do usuário na Central de Alertas — sempre com WHERE
// empresa_id = $2 (nunca deixa uma empresa alterar/ver o alerta de outra,
// mesmo sabendo o id — regra de segurança pedida explicitamente pelo
// usuário pro resto do sistema, aplicada aqui também).
async function marcarAlertaVisualizado(id, empresaId) {
  const { rows } = await pool.query(
    `UPDATE radar_alertas SET visualizado_em = COALESCE(visualizado_em, now())
     WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    [id, empresaId]
  );
  return !!rows.length;
}

async function marcarAlertaIgnorado(id, empresaId) {
  const { rows } = await pool.query(
    `UPDATE radar_alertas SET status = 'ignorado', ignorado_em = now()
     WHERE id = $1 AND empresa_id = $2 AND status != 'resolvido' RETURNING id`,
    [id, empresaId]
  );
  return !!rows.length;
}

// Resolução MANUAL pelo usuário (diferente do auto-resolve do ciclo
// periódico, que só roda quando a situação de fato deixou de existir) —
// pedido implícito pelo status "Resolvido" da Central de Alertas: o
// usuário pode ter corrigido o problema fora do ERP (ex.: renegociou o
// frete direto com a transportadora) e quer marcar como resolvido antes do
// próximo ciclo do Radar confirmar sozinho.
async function marcarAlertaResolvidoManual(id, empresaId) {
  const { rows } = await pool.query(
    `UPDATE radar_alertas SET status = 'resolvido', resolvido_em = now()
     WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    [id, empresaId]
  );
  return !!rows.length;
}

// Reabre um alerta ignorado/resolvido manualmente (volta a 'aberto',
// zerando visualizado_em pra contar como Novo de novo) — usado quando o
// usuário muda de ideia antes do próximo ciclo do Radar reavaliar sozinho.
async function reabrirAlertaManual(id, empresaId) {
  const { rows } = await pool.query(
    `UPDATE radar_alertas SET status = 'aberto', resolvido_em = NULL, ignorado_em = NULL, visualizado_em = NULL
     WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    [id, empresaId]
  );
  return !!rows.length;
}

module.exports = {
  executarCicloRadarEmpresa,
  executarCicloRadar,
  obterRadarParaEmpresa,
  listarAlertasCentral,
  marcarAlertaVisualizado,
  marcarAlertaIgnorado,
  marcarAlertaResolvidoManual,
  reabrirAlertaManual,
  SEVERIDADE_ORDEM,
  SEVERIDADE_LABEL,
  SEVERIDADE_EMOJI,
  PRIORIDADE_POR_SEVERIDADE,
  PRIORIDADE_LABEL,
  STATUS_CENTRAL_LABEL,
  statusCentralDoRegistro,
  formatMoney,
};
