const { test } = require('node:test');
const assert = require('node:assert/strict');

const importacao = require('../lib/contasPagarImportacao');

test('normaliza valor brasileiro com símbolo e milhares', () => {
  assert.equal(importacao.normalizarValor('R$ 5.480,90'), 5480.90);
});

test('normaliza formatos de valor brasileiros e internacionais', () => {
  assert.equal(importacao.normalizarValor('5480,90'), 5480.90);
  assert.equal(importacao.normalizarValor('5480.90'), 5480.90);
  assert.equal(importacao.normalizarValor(5480.9), 5480.90);
  assert.equal(importacao.normalizarValor('abc'), null);
});

test('normaliza datas brasileiras e ISO sem mudar o dia', () => {
  assert.equal(importacao.normalizarData('28/08/2026'), '2026-08-28');
  assert.equal(importacao.normalizarData('28-08-2026'), '2026-08-28');
  assert.equal(importacao.normalizarData('2026-08-28'), '2026-08-28');
  assert.equal(importacao.normalizarData('31/02/2026'), null);
});

test('sugere mapeamento para nomes de colunas comuns', () => {
  const mapa = importacao.sugerirMapeamento(['Fornecedor/Nome', 'Descrição', 'Dt Venc.', 'Vlr Total', 'Parcela', 'Status']);
  assert.equal(mapa.fornecedor, 'Fornecedor/Nome');
  assert.equal(mapa.descricao, 'Descrição');
  assert.equal(mapa.vencimento, 'Dt Venc.');
  assert.equal(mapa.valor, 'Vlr Total');
  assert.equal(mapa.parcela, 'Parcela');
  assert.equal(mapa.status, 'Status');
});

test('lê CSV com ponto e vírgula e preserva campo com vírgula entre aspas', () => {
  const csv = Buffer.from('Fornecedor;Descrição;Vencimento;Valor\nABC;"Compra, agosto";28/08/2026;"R$ 1.250,50"\n', 'utf8');
  const r = importacao.lerCsvBuffer(csv);
  assert.deepEqual(r.colunas, ['Fornecedor', 'Descrição', 'Vencimento', 'Valor']);
  assert.equal(r.linhas.length, 1);
  assert.equal(r.linhas[0]['Descrição'], 'Compra, agosto');
  assert.equal(r.linhas[0]['Valor'], 'R$ 1.250,50');
});

test('prepara linha pendente e resolve fornecedor cadastrado por nome', () => {
  const mapa = { fornecedor:'Fornecedor', descricao:'Descrição', vencimento:'Vencimento', valor:'Valor', status:'Status', parcela:'Parcela', documento:'Documento' };
  const fornecedores = { 'fornecedor abc': { id: 77, nome: 'Fornecedor ABC' } };
  const r = importacao.prepararLinha({ Fornecedor:'Fornecedor ABC', 'Descrição':'Chapas', Vencimento:'28/08/2026', Valor:'R$ 1.250,50', Status:'Pendente', Parcela:'1/3', Documento:'NF123' }, mapa, { fornecedoresPorNome: fornecedores });
  assert.deepEqual(r.erros, []);
  assert.equal(r.dados.fornecedorId, 77);
  assert.equal(r.dados.fornecedorNomeImportado, null);
  assert.equal(r.dados.valor, 1250.50);
  assert.equal(r.dados.vencimento, '2026-08-28');
  assert.equal(r.dados.status, 'pendente');
});

test('mantém nome de fornecedor não cadastrado sem inventar cadastro', () => {
  const mapa = { fornecedor:'Fornecedor', descricao:'Descrição', vencimento:'Vencimento', valor:'Valor' };
  const r = importacao.prepararLinha({ Fornecedor:'Novo Fornecedor', 'Descrição':'Serviço', Vencimento:'2026-09-05', Valor:'500,00' }, mapa, { fornecedoresPorNome: {} });
  assert.deepEqual(r.erros, []);
  assert.equal(r.dados.fornecedorId, null);
  assert.equal(r.dados.fornecedorNomeImportado, 'Novo Fornecedor');
});

test('conta importada como paga exige data de pagamento e recusa pagamento parcial', () => {
  const mapa = { descricao:'Descrição', vencimento:'Vencimento', valor:'Valor', status:'Status', dataPagamento:'Data Pagamento', valorPago:'Valor Pago' };
  const semData = importacao.prepararLinha({ 'Descrição':'Conta paga', Vencimento:'28/08/2026', Valor:'100', Status:'Pago' }, mapa);
  assert.ok(semData.erros.some(e => e.includes('data de pagamento')));

  const parcial = importacao.prepararLinha({ 'Descrição':'Conta paga', Vencimento:'28/08/2026', Valor:'100', Status:'Pago', 'Data Pagamento':'28/08/2026', 'Valor Pago':'80' }, mapa);
  assert.ok(parcial.erros.some(e => e.includes('pagamento parcial')));
});

test('vencido vindo da planilha é normalizado para pendente', () => {
  const mapa = { descricao:'Descrição', vencimento:'Vencimento', valor:'Valor', status:'Status' };
  const r = importacao.prepararLinha({ 'Descrição':'Conta antiga', Vencimento:'01/08/2026', Valor:'100', Status:'Vencido' }, mapa);
  assert.equal(r.dados.status, 'pendente');
});

test('gera a mesma chave de duplicidade para o mesmo documento/parcela', () => {
  const base = { fornecedorId: 7, fornecedorNomeImportado:null, descricao:'Compra', documento:'NF 123', parcela:'1/3', valor:100, vencimento:'2026-09-10' };
  assert.equal(importacao.chaveDuplicidade(base, 2), importacao.chaveDuplicidade({ ...base, descricao:'Descrição diferente' }, 2));
});

test('avalia erros, duplicidades já existentes e duplicidade dentro da própria planilha', () => {
  const mapa = { descricao:'Descrição', vencimento:'Vencimento', valor:'Valor', documento:'Documento', parcela:'Parcela' };
  const linhas = [
    { 'Descrição':'A', Vencimento:'10/09/2026', Valor:'100', Documento:'NF1', Parcela:'1/1' },
    { 'Descrição':'A repetida', Vencimento:'10/09/2026', Valor:'100', Documento:'NF1', Parcela:'1/1' },
    { 'Descrição':'Sem valor', Vencimento:'11/09/2026', Valor:'' },
    { 'Descrição':'Já existe', Vencimento:'12/09/2026', Valor:'200', Documento:'NF2', Parcela:'1/1' },
  ];
  const existente = importacao.prepararLinha(linhas[3], mapa).dados;
  const avaliacao = importacao.avaliarLinhas({ empresaId:2, linhas, mapeamento:mapa, chavesExistentes:new Set([importacao.chaveDuplicidade(existente, 2)]) });
  assert.equal(avaliacao[0].status, 'pronto');
  assert.equal(avaliacao[1].status, 'duplicidade');
  assert.equal(avaliacao[2].status, 'erro');
  assert.equal(avaliacao[3].status, 'duplicidade');
});

test('preview consulta fornecedor, marca duplicidade do banco e resume o lote', async () => {
  const fakeDb = {
    async query(sql) {
      if (sql.includes('FROM empresas')) return { rows:[{ id:2 }] };
      if (sql.includes('FROM fornecedores')) return { rows:[{ id:7, razao_social:'Fornecedor ABC', nome_fantasia:null }] };
      if (sql.includes('FROM contas_pagar')) return { rows:[{ fornecedor_id:7, fornecedor_nome_importado:null, descricao:'Já existe', documento:'NF9', parcela:'1/1', valor:'300.00', vencimento:'2026-09-20' }] };
      throw new Error('query inesperada: '+sql);
    }
  };
  const linhas = [
    { Fornecedor:'Fornecedor ABC', Descrição:'Nova', Vencimento:'19/09/2026', Valor:'100' },
    { Fornecedor:'Fornecedor ABC', Descrição:'Já existe', Vencimento:'20/09/2026', Valor:'300', Documento:'NF9', Parcela:'1/1' },
    { Fornecedor:'Fornecedor ABC', Descrição:'Inválida', Vencimento:'xx', Valor:'100' },
  ];
  const mapeamento = { fornecedor:'Fornecedor', descricao:'Descrição', vencimento:'Vencimento', valor:'Valor', documento:'Documento', parcela:'Parcela' };
  const r = await importacao.previsualizarImportacao({ empresaId:2, linhas, mapeamento }, fakeDb);
  assert.equal(r.resumo.total, 3);
  assert.equal(r.resumo.prontas, 1);
  assert.equal(r.resumo.duplicidades, 1);
  assert.equal(r.resumo.erros, 1);
  assert.equal(r.itens[0].dados.fornecedorId, 7);
});

test('confirma lote em transação, importa válidas e ignora erro/duplicidade', async () => {
  const inserts = [];
  const client = {
    async query(sql, params) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rows:[] };
      if (sql.includes('FROM empresas')) return { rows:[{ id:2 }] };
      if (sql.includes('FROM fornecedores')) return { rows:[] };
      if (sql.startsWith('SELECT fornecedor_id')) return { rows:[{ fornecedor_id:null, fornecedor_nome_importado:null, descricao:'Existente', documento:'NF2', parcela:'1/1', valor:'200.00', vencimento:'2026-09-20' }] };
      if (sql.includes('INSERT INTO contas_pagar_importacoes')) return { rows:[{ id:55 }] };
      if (sql.includes('INSERT INTO contas_pagar (')) { inserts.push(params); return { rows:[{ id:900 + inserts.length }] }; }
      if (sql.includes('UPDATE contas_pagar_importacoes')) return { rows:[] };
      throw new Error('query inesperada: '+sql);
    },
    release() {}
  };
  const fakePool = { async connect(){ return client; } };
  const linhas = [
    { Descrição:'Nova', Vencimento:'19/09/2026', Valor:'100' },
    { Descrição:'Existente', Vencimento:'20/09/2026', Valor:'200', Documento:'NF2', Parcela:'1/1' },
    { Descrição:'Inválida', Vencimento:'xx', Valor:'100' },
  ];
  const mapeamento = { descricao:'Descrição', vencimento:'Vencimento', valor:'Valor', documento:'Documento', parcela:'Parcela' };
  const r = await importacao.confirmarImportacao({ empresaId:2, linhas, mapeamento, nomeArquivo:'contas.csv', forceLinhas:[] }, fakePool);
  assert.equal(r.importacaoId, 55);
  assert.equal(r.importadas, 1);
  assert.equal(r.duplicidadesIgnoradas, 1);
  assert.equal(r.erros, 1);
  assert.equal(inserts.length, 1);
});

test('lê primeira aba XLSX e converte valores de células para linhas', async () => {
  const data = [
    ['Descrição','Vencimento','Valor'],
    ['Conta XLSX', new Date(Date.UTC(2026,7,28)), 450.25],
  ];
  class FakeWorkbook {
    constructor(){
      this.worksheets = [];
      this.xlsx = { load: async () => {
        this.worksheets = [{
          name:'Contas', rowCount:data.length, columnCount:3,
          getRow(n){ return { getCell(c){ return { value:data[n-1][c-1] }; } }; }
        }];
      }};
    }
  }
  const r = await importacao.lerXlsxBuffer(Buffer.from('fake'), { Workbook: FakeWorkbook });
  assert.deepEqual(r.colunas, ['Descrição','Vencimento','Valor']);
  assert.equal(r.linhas[0]['Descrição'], 'Conta XLSX');
  assert.equal(r.linhas[0]['Vencimento'] instanceof Date, true);
  assert.equal(r.nomeAba, 'Contas');
});

test('estrutura do ERP expõe endpoints, schema e botão de importação de contas a pagar', () => {
  const fs = require('node:fs');
  const schema = fs.readFileSync(require('node:path').join(__dirname, '../db/schema.sql'), 'utf8');
  const route = fs.readFileSync(require('node:path').join(__dirname, '../routes/contasPagar.js'), 'utf8');
  const front = fs.readFileSync(require('node:path').join(__dirname, '../public/index.html'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS contas_pagar_importacoes/);
  assert.match(schema, /fornecedor_nome_importado/);
  assert.match(schema, /importacao_id/);
  assert.match(route, /\/importar\/ler/);
  assert.match(route, /\/importar\/preview/);
  assert.match(route, /\/importar\/confirmar/);
  assert.match(route, /\/importar\/modelo/);
  assert.match(front, /btnImportContasPagar/);
});

test('normaliza timestamp ISO vindo do XLSX serializado pelo navegador', () => {
  assert.equal(importacao.normalizarData('2026-08-28T00:00:00.000Z'), '2026-08-28');
});

test('interpreta ponto isolado com três dígitos como separador de milhar brasileiro', () => {
  assert.equal(importacao.normalizarValor('1.250'), 1250);
});
