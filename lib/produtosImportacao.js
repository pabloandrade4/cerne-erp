// Atualização de CUSTO dos produtos por planilha (02/10/2026, pedido explícito
// do usuário: "quero atualizar os custos dos produtos, tem que ter como fazer
// isso por planilha"). Fluxo: o usuário baixa a planilha com os produtos
// atuais (SKU, Nome, Custo), edita a coluna Custo no Excel e envia de volta;
// o sistema mostra uma prévia (o que vai mudar) e só grava depois da
// confirmação. Reaproveita a leitura de CSV/XLSX e a normalização de número
// já usadas na importação de Contas a Pagar (lib/contasPagarImportacao.js) —
// nunca um parser paralelo.
//
// Regras: casa o SKU sem diferenciar maiúscula/minúscula nem espaços nas
// pontas (mesma normalização UPPER(BTRIM) usada na margem — ver
// lib/relatorioVendas.js); só ATUALIZA custo de produto que já existe (SKU
// que não está cadastrado é listado como "não encontrado" e nunca é criado
// sozinho); nunca mexe em nome/status; custo inválido ou negativo vira erro
// na linha, sem travar o resto.
const importacao = require('./contasPagarImportacao');

function round2(n) { return Math.round(n * 100) / 100; }

const ALIASES = {
  sku: ['sku', 'codigo', 'cod', 'codigo sku', 'sku produto', 'referencia'],
  custo: ['custo', 'novo custo', 'custo novo', 'custo unitario', 'custo atual', 'preco de custo', 'custo r', 'valor custo'],
};

function normSku(s) { return String(s === null || s === undefined ? '' : s).trim().toUpperCase(); }

function detectarColunas(colunas) {
  const out = { sku: null, custo: null };
  const norm = (colunas || []).map(c => ({ original: c, slug: importacao.slugHeader(c) }));
  for (const campo of Object.keys(out)) {
    for (const alias of ALIASES[campo]) {
      const achou = norm.find(c => c.slug === alias);
      if (achou) { out[campo] = achou.original; break; }
    }
  }
  return out;
}

// Cálculo puro (testável sem banco): cruza as linhas da planilha com os
// produtos cadastrados e diz, linha a linha, o que vai acontecer.
function avaliarLinhas(linhas, mapeamento, produtos) {
  const porSku = new Map();
  for (const p of produtos) {
    const k = normSku(p.sku);
    if (!porSku.has(k)) porSku.set(k, []);
    porSku.get(k).push(p);
  }
  const vistos = new Map(); // sku normalizado -> índice no resultado (último vence)
  const resultado = [];
  let duplicadasNaPlanilha = 0;
  linhas.forEach((linha, i) => {
    const skuBruto = linha[mapeamento.sku];
    const sku = normSku(skuBruto);
    const numeroLinha = i + 2; // +1 cabeçalho, +1 base 1 — igual ao Excel
    if (!sku) { resultado.push({ linha: numeroLinha, status: 'erro', motivo: 'SKU vazio.' }); return; }
    const custoBruto = linha[mapeamento.custo];
    if (custoBruto === null || custoBruto === undefined || String(custoBruto).trim() === '') {
      resultado.push({ linha: numeroLinha, sku: String(skuBruto).trim(), status: 'ignorada', motivo: 'Custo em branco — mantido o atual.' });
      return;
    }
    const custo = importacao.normalizarValor(custoBruto);
    if (custo === null || custo < 0) {
      resultado.push({ linha: numeroLinha, sku: String(skuBruto).trim(), status: 'erro', motivo: 'Custo inválido ("' + String(custoBruto).trim() + '").' });
      return;
    }
    const encontrados = porSku.get(sku);
    if (!encontrados) {
      resultado.push({ linha: numeroLinha, sku: String(skuBruto).trim(), custoNovo: custo, status: 'nao_encontrado', motivo: 'SKU não cadastrado em Produtos.' });
      return;
    }
    const atual = Number(encontrados[0].custo);
    const item = {
      linha: numeroLinha, sku: String(skuBruto).trim(), produtoIds: encontrados.map(p => p.id), nome: encontrados[0].nome,
      custoAtual: atual, custoNovo: custo, status: round2(atual) === custo ? 'sem_mudanca' : 'atualizar',
    };
    if (vistos.has(sku)) { duplicadasNaPlanilha++; resultado[vistos.get(sku)].status = 'ignorada'; resultado[vistos.get(sku)].motivo = 'SKU repetido na planilha — vale a última linha.'; }
    vistos.set(sku, resultado.length);
    resultado.push(item);
  });
  const conta = (s) => resultado.filter(r => r.status === s).length;
  return {
    linhas: resultado,
    resumo: {
      total: resultado.length,
      aAtualizar: conta('atualizar'), semMudanca: conta('sem_mudanca'),
      naoEncontrados: conta('nao_encontrado'), erros: conta('erro'), ignoradas: conta('ignorada'),
      duplicadasNaPlanilha,
    },
  };
}

module.exports = { avaliarLinhas, detectarColunas, normSku };
