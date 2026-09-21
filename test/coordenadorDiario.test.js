// Agente Coordenador — Etapa 3 da Daily dos Agentes (20/09/2026, pedido
// explícito do usuário, ver comentário grande no topo de
// lib/ia/coordenadorDiario.js). Testes de UNIDADE — módulo puro, sem
// Postgres nem API nenhuma, então roda sempre (nunca pulado por falta de
// DATABASE_URL, diferente dos arquivos *Ciclo.test.js desta pasta).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { gerarCorrelacoes } = require('../lib/ia/coordenadorDiario');

describe('coordenadorDiario#gerarCorrelacoes', () => {
  test('sem nenhum achado -> nenhuma correlação (nunca inventa cruzamento)', () => {
    const r = gerarCorrelacoes({ achados: [] });
    assert.deepEqual(r, []);
  });

  test('achado sem SKU nunca entra em nenhuma regra (nenhuma regra deste Coordenador cruza sem SKU)', () => {
    const achados = [
      { id: 1, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio sem SKU', sku: null, prioridade: 'alta', dados: { estoqueDisponivel: 0, estoqueSincronizado: true } },
    ];
    assert.deepEqual(gerarCorrelacoes({ achados }), []);
  });

  test('anúncios de SKUs diferentes nunca se cruzam entre si', () => {
    const achados = [
      { id: 1, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio A', sku: 'SKU-A', prioridade: 'alta', dados: {} },
      { id: 2, agenteCodigo: 'ads_performance', tipo: 'problema', titulo: 'Campanha B', sku: 'SKU-B', prioridade: 'alta', dados: { tipoAcao: 'pausar_campanha' } },
    ];
    assert.deepEqual(gerarCorrelacoes({ achados }), []);
  });

  describe('R1 — anúncio em queda + Ads pausando o mesmo SKU', () => {
    test('anúncio "problema" + Ads "pausar_campanha" no mesmo SKU -> correlação R1, citando números reais dos dois achados', () => {
      const achados = [
        { id: 10, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Caixa 50x24 parada', sku: 'CX-1', prioridade: 'alta', dados: { diasSemVenda: 18, variacaoQuantidade7dPct: -65 } },
        { id: 11, agenteCodigo: 'ads_performance', tipo: 'problema', titulo: 'Campanha Caixa 50x24 — pausar campanha', sku: 'CX-1', prioridade: 'alta', dados: { tipoAcao: 'pausar_campanha', orcamentoAtual: 300 } },
      ];
      const r = gerarCorrelacoes({ achados });
      assert.equal(r.length, 1);
      assert.equal(r[0].regraCodigo, 'r1_ads_pausado_correlaciona_queda_anuncio');
      assert.equal(r[0].sku, 'CX-1');
      assert.deepEqual(r[0].achadosRelacionados.sort(), [10, 11]);
      assert.equal(r[0].prioridade, 'alta');
      assert.match(r[0].conclusao, /18 dia\(s\) sem venda/);
      assert.match(r[0].conclusao, /R\$ 300,00/);
      assert.match(r[0].conclusao, /Caixa 50x24 parada/);
    });

    test('Ads "diminuir_orcamento" (não é pausa) NUNCA dispara R1 — só pausar_anuncio/pausar_campanha contam', () => {
      const achados = [
        { id: 20, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio C', sku: 'CX-2', prioridade: 'media', dados: {} },
        { id: 21, agenteCodigo: 'ads_performance', tipo: 'problema', titulo: 'Campanha C', sku: 'CX-2', prioridade: 'media', dados: { tipoAcao: 'diminuir_orcamento' } },
      ];
      assert.deepEqual(gerarCorrelacoes({ achados }), []);
    });

    test('anúncio "oportunidade" (crescimento) nunca dispara R1, mesmo com Ads pausado no mesmo SKU', () => {
      const achados = [
        { id: 30, agenteCodigo: 'anuncios_radar', tipo: 'oportunidade', titulo: 'Anúncio D crescendo', sku: 'CX-3', prioridade: 'baixa', dados: {} },
        { id: 31, agenteCodigo: 'ads_performance', tipo: 'problema', titulo: 'Campanha D', sku: 'CX-3', prioridade: 'alta', dados: { tipoAcao: 'pausar_anuncio' } },
      ];
      assert.deepEqual(gerarCorrelacoes({ achados }), []);
    });
  });

  describe('R2 — estoque zerado', () => {
    test('anúncio com estoqueDisponivel=0 e sincronizado -> correlação R2, mesmo sem nenhum outro agente', () => {
      const achados = [
        { id: 40, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio E sem estoque', sku: 'CX-4', prioridade: 'media', dados: { estoqueDisponivel: 0, estoqueSincronizado: true, diasSemVenda: 4 } },
      ];
      const r = gerarCorrelacoes({ achados });
      assert.equal(r.length, 1);
      assert.equal(r[0].regraCodigo, 'r2_estoque_zerado_anuncio');
      assert.deepEqual(r[0].achadosRelacionados, [40]);
      assert.match(r[0].conclusao, /ZERADO/);
    });

    test('estoque NÃO sincronizado (pendente) com quantidade 0 nunca dispara R2 — número não confiável ainda', () => {
      const achados = [
        { id: 41, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio F', sku: 'CX-5', prioridade: 'media', dados: { estoqueDisponivel: 0, estoqueSincronizado: false } },
      ];
      assert.deepEqual(gerarCorrelacoes({ achados }), []);
    });

    test('estoque positivo nunca dispara R2', () => {
      const achados = [
        { id: 42, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio G', sku: 'CX-6', prioridade: 'media', dados: { estoqueDisponivel: 5, estoqueSincronizado: true } },
      ];
      assert.deepEqual(gerarCorrelacoes({ achados }), []);
    });
  });

  describe('R3 — anúncio em queda + Promoções saindo por margem comprometida', () => {
    test('anúncio "problema" + Promoções "sair_promocao" no mesmo SKU -> correlação R3, citando desconto e margem reais', () => {
      const achados = [
        { id: 50, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio H caiu', sku: 'CX-7', prioridade: 'media', dados: {} },
        { id: 51, agenteCodigo: 'promocoes', tipo: 'problema', titulo: 'Promoção H', sku: 'CX-7', prioridade: 'alta', dados: { tipoAcao: 'sair_promocao', descontoPct: 30, margemRealPct: 1.5 } },
      ];
      const r = gerarCorrelacoes({ achados });
      assert.equal(r.length, 1);
      assert.equal(r[0].regraCodigo, 'r3_promocao_compromete_margem_anuncio');
      assert.equal(r[0].prioridade, 'alta'); // herda a maior prioridade entre os achados cruzados
      assert.match(r[0].conclusao, /30,0%/);
      assert.match(r[0].conclusao, /1,5%/);
    });

    test('Promoções "revisar_preco" (não é sair_promocao) nunca dispara R3', () => {
      const achados = [
        { id: 60, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio I', sku: 'CX-8', prioridade: 'media', dados: {} },
        { id: 61, agenteCodigo: 'promocoes', tipo: 'problema', titulo: 'Promoção I', sku: 'CX-8', prioridade: 'media', dados: { tipoAcao: 'revisar_preco' } },
      ];
      assert.deepEqual(gerarCorrelacoes({ achados }), []);
    });
  });

  describe('R4 — anúncio em queda + concorrente cadastrado manualmente', () => {
    test('anúncio "problema" + concorrente cadastrado pro mesmo SKU -> correlação R4, citando o link real (nunca afirma ser a causa)', () => {
      const achados = [
        { id: 70, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio J caiu', sku: 'CX-9', prioridade: 'baixa', dados: {} },
      ];
      const concorrentesMonitoradosPorSku = { 'CX-9': [{ id: 1, url: 'https://exemplo.com/concorrente-j', apelido: 'Loja Rival J' }] };
      const r = gerarCorrelacoes({ achados, concorrentesMonitoradosPorSku });
      assert.equal(r.length, 1);
      assert.equal(r[0].regraCodigo, 'r4_concorrente_cadastrado_anuncio');
      assert.match(r[0].conclusao, /Loja Rival J/);
      assert.match(r[0].conclusao, /https:\/\/exemplo\.com\/concorrente-j/);
      assert.match(r[0].conclusao, /não permite confirmar automaticamente/);
    });

    test('sem nenhum concorrente cadastrado pro SKU -> R4 nunca dispara', () => {
      const achados = [
        { id: 80, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio K', sku: 'CX-10', prioridade: 'baixa', dados: {} },
      ];
      assert.deepEqual(gerarCorrelacoes({ achados, concorrentesMonitoradosPorSku: {} }), []);
      assert.deepEqual(gerarCorrelacoes({ achados }), []);
    });
  });

  test('SKU com achados pra 3 regras ao mesmo tempo -> gera as 3 correlações, cada uma com seus próprios achadosRelacionados', () => {
    const achados = [
      { id: 90, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio L caiu', sku: 'CX-11', prioridade: 'alta', dados: { diasSemVenda: 12 } },
      { id: 91, agenteCodigo: 'ads_performance', tipo: 'problema', titulo: 'Campanha L', sku: 'CX-11', prioridade: 'alta', dados: { tipoAcao: 'pausar_anuncio' } },
      { id: 92, agenteCodigo: 'promocoes', tipo: 'problema', titulo: 'Promoção L', sku: 'CX-11', prioridade: 'media', dados: { tipoAcao: 'sair_promocao', descontoPct: 15 } },
    ];
    const concorrentesMonitoradosPorSku = { 'CX-11': [{ id: 5, url: 'https://exemplo.com/l', apelido: null }] };
    const r = gerarCorrelacoes({ achados, concorrentesMonitoradosPorSku });
    const regras = r.map((c) => c.regraCodigo).sort();
    assert.deepEqual(regras, [
      'r1_ads_pausado_correlaciona_queda_anuncio',
      'r3_promocao_compromete_margem_anuncio',
      'r4_concorrente_cadastrado_anuncio',
    ]);
  });

  test('correlação sem apelido cadastrado cita só o link (nunca um nome inventado)', () => {
    const achados = [
      { id: 100, agenteCodigo: 'anuncios_radar', tipo: 'problema', titulo: 'Anúncio M', sku: 'CX-12', prioridade: 'baixa', dados: {} },
    ];
    const concorrentesMonitoradosPorSku = { 'CX-12': [{ id: 6, url: 'https://exemplo.com/m', apelido: null }] };
    const r = gerarCorrelacoes({ achados, concorrentesMonitoradosPorSku });
    assert.match(r[0].conclusao, /https:\/\/exemplo\.com\/m/);
  });
});
