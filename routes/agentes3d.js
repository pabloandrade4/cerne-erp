// Sala dos Agentes — visualização 3D dos processos automáticos do servidor
// (pedido explícito do usuário: "tem como fazer agentes de IA pra rodar
// 24h por dia e fazer uma sala 3D onde vai mostrar todos agentes
// trabalhando?"). Router bem fino, propositalmente: NENHUM cálculo/estado
// novo é criado aqui (fora das contagens honestas abaixo) — cada agente já
// roda 24h por dia sozinho no servidor desde antes (ver server.js#start,
// cada um com seu próprio scheduler em lib/*Scheduler.js).
//
// REESCRITA (19/09/2026, pedido explícito do usuário): "sobre as IA não são
// aquelas... as que estão lá tem efeitos mas podem ficar por trás das
// câmeras tipo sincronização de pedidos não tem porque ninguém saber" — a
// Sala dos Agentes passa a mostrar só os 5 setores que o usuário pediu
// (Promoções, Ads, Anúncios, Análise de Concorrente, SAC). Sincronizações
// de pedidos/estoque/Shopee e Despesas Fixas CONTINUAM rodando 24h por dia
// exatamente como antes (nada foi desligado) — só saíram desta tela; quem
// precisar do status delas encontra em Marketplaces/Despesas Fixas (cada
// uma já tinha seu próprio indicador antes da Sala dos Agentes existir). A
// Daily (resumo por WhatsApp) também saiu por ser mais um "relatório" que
// um agente que o usuário queira ver trabalhando — pode voltar se for
// pedido.
const express = require('express');
const pool = require('../db/pool');
const { obterStatusSincronizacaoAds } = require('../lib/adsScheduler');
const { obterStatusScheduler: obterStatusRadar } = require('../lib/ia/radarScheduler');
const { obterStatusScheduler: obterStatusPromocoes } = require('../lib/ia/promocoesScheduler');
const { obterStatusScheduler: obterStatusSac } = require('../lib/ia/sacScheduler');
const { obterStatusScheduler: obterStatusConcorrente } = require('../lib/ia/concorrenteScheduler');

const router = express.Router();

// Contagens ao vivo (direto do banco, nunca do estado em memória do
// scheduler) — pra cada setor mostrar o que a IA está de fato sugerindo
// AGORA, não só "rodou ou não rodou". Cada consulta é isolada: uma falha
// numa nunca derruba as outras (Promise.allSettled abaixo).
async function contarPendentesAds() {
  const { rows } = await pool.query(`SELECT count(*)::int AS total FROM ia_decisoes_ads WHERE status_decisao = 'pendente'`);
  return rows[0].total;
}
async function contarPendentesPromocoes() {
  const { rows } = await pool.query(`SELECT count(*)::int AS total FROM ia_decisoes_promocoes WHERE status_decisao = 'pendente'`);
  return rows[0].total;
}
// Só "anuncio_*" (ver lib/ia/radarAnuncios.js) — nunca os alertas
// financeiros/de negócio que o mesmo Radar também gera (lib/ia/radarNegocio.js),
// que ficam de fora deste setor por pedido explícito do usuário: "Radar só
// pode aparecer como 'Anúncios' se for só anúncio".
async function contarAlertasDeAnuncioAbertos() {
  const { rows } = await pool.query(`SELECT count(*)::int AS total FROM radar_alertas WHERE status = 'aberto' AND categoria LIKE 'anuncio_%'`);
  return rows[0].total;
}
// "Análise de Concorrente" virou automática (19/09/2026, pedido explícito
// do usuário: "quero que essas ia nunca pare de trabalhar... sempre buscar
// concorrentes que estão vendendo o mesmo produto que eu" — ver
// lib/ia/radarConcorrente.js/concorrenteScheduler.js). Mesma categoria
// única usada lá (`concorrente_ativo`), nunca confundida com os alertas de
// Anúncios/Negócio que usam outros prefixos.
async function contarAlertasDeConcorrenteAbertos() {
  const { rows } = await pool.query(`SELECT count(*)::int AS total FROM radar_alertas WHERE status = 'aberto' AND categoria = 'concorrente_ativo'`);
  return rows[0].total;
}

router.get('/status', async (req, res, next) => {
  try {
    const ads = obterStatusSincronizacaoAds();
    const radar = obterStatusRadar();
    const promocoes = obterStatusPromocoes();
    const sac = obterStatusSac();
    const concorrente = obterStatusConcorrente();

    const [pendentesAds, pendentesPromocoes, alertasAnuncio, alertasConcorrente] = await Promise.all([
      contarPendentesAds().catch((err) => { console.error('[Sala dos Agentes] contarPendentesAds falhou:', err.message); return null; }),
      contarPendentesPromocoes().catch((err) => { console.error('[Sala dos Agentes] contarPendentesPromocoes falhou:', err.message); return null; }),
      contarAlertasDeAnuncioAbertos().catch((err) => { console.error('[Sala dos Agentes] contarAlertasDeAnuncioAbertos falhou:', err.message); return null; }),
      contarAlertasDeConcorrenteAbertos().catch((err) => { console.error('[Sala dos Agentes] contarAlertasDeConcorrenteAbertos falhou:', err.message); return null; }),
    ]);

    const agentes = [
      {
        id: 'promocoes-ia', nome: 'Promoções', categoria: 'promocoes',
        ativo: promocoes.ativo, emExecucao: promocoes.emExecucao, intervaloMs: promocoes.intervaloMs,
        ultimaExecucaoEm: promocoes.ultimaExecucaoEm, ultimoCicloOk: promocoes.ultimoCicloOk,
        resumo: pendentesPromocoes === null ? 'Não foi possível consultar agora.' : (pendentesPromocoes + ' sugestão(ões) pendente(s) de aprovação'),
      },
      {
        id: 'ads', nome: 'Ads', categoria: 'ads',
        ativo: ads.ativo, emExecucao: ads.emExecucao, intervaloMs: ads.intervaloMs,
        ultimaExecucaoEm: ads.ultimaExecucaoEm, ultimoCicloOk: ads.ultimoCicloOk,
        resumo: pendentesAds === null ? 'Não foi possível consultar agora.' : (pendentesAds + ' sugestão(ões) pendente(s) de aprovação'),
      },
      {
        id: 'anuncios-ia', nome: 'Anúncios', categoria: 'anuncios',
        ativo: radar.ativo, emExecucao: radar.emExecucao, intervaloMs: radar.intervaloMs,
        ultimaExecucaoEm: radar.ultimaExecucaoEm, ultimoCicloOk: radar.ultimoCicloOk,
        resumo: alertasAnuncio === null ? 'Não foi possível consultar agora.' : (alertasAnuncio + ' alerta(s) de anúncio em aberto'),
      },
      {
        // Virou ciclo automático (19/09/2026, pedido explícito do usuário —
        // ver lib/ia/concorrenteScheduler.js): varre os produtos com venda
        // real no Mercado Livre 1x por dia e avisa por WhatsApp quando
        // aparece algo novo/pior. A busca manual (Agentes IA → Análise de
        // Concorrente) continua funcionando do mesmo jeito, pra conferir um
        // produto específico na hora.
        id: 'concorrente-ia', nome: 'Análise de Concorrente', categoria: 'concorrente',
        ativo: concorrente.ativo, emExecucao: concorrente.emExecucao, intervaloMs: concorrente.intervaloMs,
        ultimaExecucaoEm: concorrente.ultimaExecucaoEm, ultimoCicloOk: concorrente.ultimoCicloOk,
        resumo: alertasConcorrente === null ? 'Não foi possível consultar agora.' : (alertasConcorrente + ' concorrente(s) ativo(s) encontrado(s)'),
      },
      {
        id: 'sac-ia', nome: 'SAC', categoria: 'sac',
        ativo: sac.ativo, emExecucao: sac.emExecucao, intervaloMs: sac.intervaloMs,
        ultimaExecucaoEm: sac.ultimaExecucaoEm, ultimoCicloOk: sac.ultimoCicloOk,
        resumo: sac.mercadoLivre ? (((sac.mercadoLivre.sugestoesGeradas || 0) + (sac.shopee ? sac.shopee.sugestoesGeradas || 0 : 0)) + ' sugestão(ões) de resposta pendente(s)') : 'Aguardando o 1º ciclo.',
      },
    ];

    res.json({ agentes });
  } catch (err) { next(err); }
});

module.exports = router;
