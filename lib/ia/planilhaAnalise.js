// Gera a planilha XLSX de uma resposta da IA Gestora (Passo 3 da tarefa "IA
// Gestora — central de análise", ver docs/02-decisoes.md).
//
// Regra central do usuário: "A planilha deve utilizar os MESMOS dados da
// resposta. Não pode acontecer de a conversa mostrar um total e a planilha
// mostrar outro." — por isso esta função recebe exatamente o mesmo objeto
// `estruturado` que lib/ia/estrutura.js montou (e que fica salvo em
// ia_mensagens.estruturado) e NUNCA consulta o banco de novo. A mesma
// planilha, gerada hoje ou daqui a um ano, sempre reflete o que a conversa
// mostrou naquele momento — nunca um número recalculado por acaso diferente
// (ex: se um custo for editado depois, a resposta antiga e a planilha dela
// continuam batendo entre si, mesmo que já não batam com o ERP ao vivo —
// isso é o comportamento certo pra um HISTÓRICO).
//
// Mesmas convenções visuais já usadas em routes/relatorios.js (fonte Arial,
// dinheiro em "R$ #,##0.00", percentual como fração com "0.0%", cabeçalho
// congelado) — nenhuma regra nova de formatação criada só pra IA.
const ExcelJS = require('exceljs');
const { diaBRT } = require('../periodo');

const SLUG_POR_FERRAMENTA = {
  produtos_desempenho: 'produtos',
  produtos_por_caixa_desempenho: 'caixas',
  desempenho_por_loja: 'lojas',
  fluxo_de_caixa: 'fluxo-caixa',
  contas_a_receber_resumo: 'contas-a-receber',
  contas_a_pagar_resumo: 'contas-a-pagar',
  dre_completa: 'dre',
  resultado_periodo: 'resultado',
  resumo_vendas: 'vendas',
  ads_desempenho: 'ads',
  comparacao_periodo_anterior: 'comparacao',
  projecao_mes: 'projecao',
  vendas_com_prejuizo: 'vendas-com-prejuizo',
};

function slugDaAnalise(ferramentas) {
  for (const nome of ferramentas || []) {
    if (SLUG_POR_FERRAMENTA[nome]) return SLUG_POR_FERRAMENTA[nome];
  }
  return 'analise';
}

// Mesmo formato de nome já usado em routes/relatorios.js
// (formatarNomeArquivoRelatorio) — reimplementado aqui, em vez de
// importado, de propósito: lib/ia é um módulo isolado, nunca depende de
// routes/ (rotas não são reaproveitáveis como biblioteca) — só duas linhas
// de lógica, então duplicar é mais seguro do que criar um acoplamento novo.
function formatarNomeArquivo(ferramentas, periodo) {
  const slug = slugDaAnalise(ferramentas);
  if (!periodo || !periodo.desde || !periodo.ate) return `relatorio-${slug}.xlsx`;
  const desde = new Date(periodo.desde);
  const ate = new Date(new Date(periodo.ate).getTime() - 1);
  const diaInicio = diaBRT(desde);
  const diaFim = diaBRT(ate);
  const base = diaInicio === diaFim ? `relatorio-${slug}-${diaInicio}` : `relatorio-${slug}-${diaInicio}-a-${diaFim}`;
  return `${base}.xlsx`;
}

function aplicarCelula(cell, tipo) {
  if (cell.value === null || cell.value === undefined) { cell.value = 'pendente'; return; }
  if (tipo === 'money') { cell.numFmt = 'R$ #,##0.00'; }
  else if (tipo === 'percent') { cell.value = Number(cell.value) / 100; cell.numFmt = '0.0%'; }
}

function montarPlanilhaAnalise(estruturado) {
  const { pergunta, empresa, periodo, resumo, kpis, tabela, graficos, insights, atencao } = estruturado;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cerne ERP — IA Gestora';
  workbook.created = new Date();

  // ---- Aba Resumo — sempre presente ----
  const resumoSheet = workbook.addWorksheet('Resumo');
  resumoSheet.getColumn(1).width = 34;
  resumoSheet.getColumn(2).width = 30;
  const linhaPergunta = resumoSheet.addRow(['Pergunta', pergunta || '—']);
  linhaPergunta.font = { italic: true, name: 'Arial' };
  resumoSheet.addRow(['Empresa', (empresa && empresa.nome) || '—']).font = { name: 'Arial' };
  resumoSheet.addRow(['Período', (periodo && periodo.label) || '—']).font = { name: 'Arial' };
  resumoSheet.addRow([]);

  if (kpis && kpis.length) {
    const header = resumoSheet.addRow(['Indicador', 'Valor']);
    header.font = { bold: true, name: 'Arial' };
    kpis.forEach((k) => {
      const valorCel = k.valorFormatado || (k.valor === null || k.valor === undefined ? 'pendente' : String(k.valor));
      const row = resumoSheet.addRow([k.label + (k.grupo ? ` (${k.grupo})` : ''), valorCel]);
      row.getCell(1).font = { name: 'Arial' };
      row.getCell(2).font = { name: 'Arial' };
    });
  }

  if (insights && insights.length) {
    resumoSheet.addRow([]);
    resumoSheet.addRow(['Principais conclusões']).font = { bold: true, name: 'Arial' };
    insights.forEach((i) => resumoSheet.addRow([i]).font = { name: 'Arial' });
  }

  if (atencao) {
    resumoSheet.addRow([]);
    const linha = resumoSheet.addRow(['Atenção', atencao]);
    linha.font = { bold: true, name: 'Arial' };
  }

  // ---- Aba Dados — só quando a análise trouxe uma tabela de verdade ----
  if (tabela && Array.isArray(tabela.linhas) && tabela.linhas.length) {
    const dadosSheet = workbook.addWorksheet('Dados');
    dadosSheet.columns = tabela.colunas.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 4) }));
    dadosSheet.getRow(1).font = { bold: true, name: 'Arial' };
    dadosSheet.views = [{ state: 'frozen', ySplit: 1 }];
    tabela.linhas.forEach((linhaObj) => {
      const row = dadosSheet.addRow(linhaObj);
      tabela.colunas.forEach((c, idx) => {
        const cell = row.getCell(idx + 1);
        cell.font = { name: 'Arial' };
        if (c.tipo === 'money' || c.tipo === 'percent') aplicarCelula(cell, c.tipo);
      });
    });
  }

  // ---- Aba Gráficos — os mesmos pontos mostrados no gráfico da conversa,
  // como tabela de categoria/série (o ExcelJS deste projeto não desenha
  // gráfico nativo — ver comentário em node_modules/exceljs/index.js — os
  // dados aqui são exatamente os do gráfico renderizado na tela, prontos
  // pra quem quiser montar um gráfico nativo no Excel a partir deles). ----
  if (graficos && graficos.length) {
    const graficosSheet = workbook.addWorksheet('Gráficos');
    graficosSheet.getColumn(1).width = 30;
    graficos.forEach((g, gi) => {
      const tituloRow = graficosSheet.addRow([g.titulo]);
      tituloRow.font = { bold: true, name: 'Arial' };
      const headerRow = graficosSheet.addRow(['Categoria', ...g.series.map((s) => s.nome)]);
      headerRow.font = { bold: true, name: 'Arial' };
      g.categorias.forEach((cat, i) => {
        const linha = [cat, ...g.series.map((s) => (s.valores[i] === undefined ? null : s.valores[i]))];
        const row = graficosSheet.addRow(linha);
        row.getCell(1).font = { name: 'Arial' };
        g.series.forEach((s, si) => {
          const cell = row.getCell(si + 2);
          cell.font = { name: 'Arial' };
          if (s.tipo === 'money' || s.tipo === 'percent') aplicarCelula(cell, s.tipo);
        });
      });
      if (gi < graficos.length - 1) graficosSheet.addRow([]);
    });
  }

  return workbook;
}

module.exports = { montarPlanilhaAnalise, formatarNomeArquivo, slugDaAnalise };
