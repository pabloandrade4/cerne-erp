const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Fluxo de Caixa usa saldo bancário consolidado e não soma extrato como segunda fórmula', () => {
  const src = fs.readFileSync(path.join(__dirname,'../lib/fluxoCaixa.js'),'utf8');
  assert.match(src, /saldoConsolidado/);
  assert.match(src, /resolverSaldoBase/);
  assert.doesNotMatch(src, /FROM\s+extrato_movimentos/i);
});

test('estrutura expõe contas bancárias, importações, movimentos e rota', () => {
  const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  assert.match(schema,/CREATE TABLE IF NOT EXISTS contas_bancarias/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS extrato_importacoes/);
  assert.match(schema,/CREATE TABLE IF NOT EXISTS extrato_movimentos/);
  assert.match(server,/\/api\/contas-bancarias/);
});

test('interface de Recebimentos oferece cadastrar conta e importar extrato com saldo final', () => {
  const front=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  assert.match(front,/btnImportExtrato/);
  assert.match(front,/Nova conta bancária/);
  assert.match(front,/Saldo final do extrato/);
  assert.match(front,/PDF do Nubank, CSV ou XLSX/);
});

test('erro de conta bancária incompatível é tratado como erro de validação', () => {
  const route=fs.readFileSync(path.join(__dirname,'../routes/contasBancarias.js'),'utf8');
  assert.match(route,/não corresponde/);
});

function somarDiasISO(iso,dias){
  const [y,m,d]=iso.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1,d)); dt.setUTCDate(dt.getUTCDate()+dias); return dt.toISOString().slice(0,10);
}

test('saldo bancário vira base do fluxo e movimentos realizados não são descontados novamente', async () => {
  const poolPath=require.resolve('../db/pool');
  const contasPagarPath=require.resolve('../lib/contasPagar');
  const contasReceberPath=require.resolve('../lib/contasReceber');
  const despesasFixasPath=require.resolve('../lib/despesasFixas');
  const recebimentosPath=require.resolve('../lib/recebimentosMl');
  const bancosPath=require.resolve('../lib/contasBancarias');
  const fluxoPath=require.resolve('../lib/fluxoCaixa');
  const periodo=require('../lib/periodo');
  const hoje=periodo.diaBRT(new Date()); const amanha=somarDiasISO(hoje,1); const depois=somarDiasISO(hoje,2);

  const fakePool={query:async(sql)=>{
    if(/FROM fluxo_caixa_saldo_inicial/.test(sql)) return {rows:[{valor:'9999',data_referencia:hoje,observacao:'fallback'}]};
    if(/SELECT vencimento, valor FROM contas_pagar/.test(sql)) return {rows:[{vencimento:amanha,valor:'200'}]};
    if(/SELECT data_prevista, valor FROM contas_receber/.test(sql)) return {rows:[{data_prevista:depois,valor:'50'}]};
    if(/SELECT data_pagamento, valor FROM contas_pagar/.test(sql)) return {rows:[{data_pagamento:hoje,valor:'100'}]};
    if(/SELECT data_recebida, valor FROM contas_receber/.test(sql)) return {rows:[{data_recebida:hoje,valor:'80'}]};
    throw new Error('Query inesperada: '+sql);
  }};
  const fakePagar={resumoContasPagar:async()=>({vencidas:0})};
  const fakeReceber={resumoContasReceber:async()=>({atrasado:0})};
  const fakeDespesas={listarDespesasFixas:async()=>[],ocorrenciasNoIntervalo:()=>[]};
  const fakeRecebimentos={listarRecebimentosMl:async()=>[]};
  const fakeBancos={
    saldoConsolidado:async()=>({valor:1000,dataReferencia:hoje,contasComSaldo:1,contasSemSaldo:0}),
    resolverSaldoBase:(b,m)=>b?{...b,fonte:'bancario'}:(m?{...m,fonte:'manual'}:null),
  };
  const replacements=[[poolPath,fakePool],[contasPagarPath,fakePagar],[contasReceberPath,fakeReceber],[despesasFixasPath,fakeDespesas],[recebimentosPath,fakeRecebimentos],[bancosPath,fakeBancos]];
  const olds=new Map(replacements.map(([p])=>[p,require.cache[p]])); const oldFluxo=require.cache[fluxoPath];
  for(const [p,exp] of replacements) require.cache[p]={id:p,filename:p,loaded:true,exports:exp}; delete require.cache[fluxoPath];
  try{
    const fluxo=require('../lib/fluxoCaixa');
    const r=await fluxo.gerarFluxoDeCaixa({empresaId:1,periodoChave:'7d'});
    assert.equal(r.saldoFonte,'bancario');
    assert.equal(r.cards.saldoAtual.valor,1000,'saldo manual não pode substituir o saldo do extrato');
    const hojeLinha=r.serieDiaria.find(x=>x.dia===hoje);
    assert.equal(hojeLinha.realizado.entradas,80);
    assert.equal(hojeLinha.realizado.saidas,100);
    assert.equal(hojeLinha.saldoAcumulado,1000,'realizado já está dentro do saldo bancário e não pode ser somado de novo');
    assert.equal(r.serieDiaria.find(x=>x.dia===amanha).saldoAcumulado,800);
    assert.equal(r.serieDiaria.find(x=>x.dia===depois).saldoAcumulado,850);
    assert.equal(r.cards.saldoProjetado.valor,850);
  } finally {
    if(oldFluxo) require.cache[fluxoPath]=oldFluxo; else delete require.cache[fluxoPath];
    for(const [p,old] of olds){if(old)require.cache[p]=old;else delete require.cache[p];}
  }
});

test('schema atualiza contas_bancarias antigas com colunas de saldo', () => {
  const schema=fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
  assert.match(schema,/ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS saldo_atual/i);
  assert.match(schema,/ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS saldo_data/i);
  assert.match(schema,/ALTER TABLE contas_bancarias ADD COLUMN IF NOT EXISTS saldo_atualizado_em/i);
});

test('fluxo continua funcionando sem saldo bancario se schema bancario antigo ainda nao estiver compativel', async () => {
  const bancos=require('../lib/contasBancarias');
  const dbAntigo={query:async()=>{ const err=new Error('column saldo_atual does not exist'); err.code='42703'; throw err; }};
  const saldo=await bancos.saldoConsolidado(1,dbAntigo);
  assert.equal(saldo,null);
});
