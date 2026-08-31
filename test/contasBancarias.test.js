const { test } = require('node:test');
const assert = require('node:assert/strict');
const contas = require('../lib/contasBancarias');

test('saldo consolidado soma somente contas ativas com saldo conhecido', async () => {
  assert.equal(typeof contas.saldoConsolidado, 'function');
  const db = { async query(sql){
    assert.match(sql, /FROM contas_bancarias/);
    return { rows:[
      {id:1,nome:'Nubank',banco:'Nubank',saldo_atual:'1000.50',saldo_data:'2026-08-31',ativo:true},
      {id:2,nome:'Mercado Pago',banco:'Mercado Pago',saldo_atual:'250.25',saldo_data:'2026-08-30',ativo:true},
      {id:3,nome:'Antiga',banco:'Outro',saldo_atual:'999',saldo_data:'2026-08-31',ativo:false},
      {id:4,nome:'Sem saldo',banco:'Outro',saldo_atual:null,saldo_data:null,ativo:true},
    ]};
  }};
  const r = await contas.saldoConsolidado(7, db);
  assert.equal(r.valor, 1250.75);
  assert.equal(r.dataReferencia, '2026-08-31');
  assert.equal(r.contasComSaldo, 2);
  assert.equal(r.contasSemSaldo, 1);
});

test('conta bancária nova valida empresa e nome', async () => {
  assert.equal(typeof contas.criarContaBancaria, 'function');
  const r = await contas.criarContaBancaria({empresaId:null,nome:''}, {query:async()=>({rows:[]})});
  assert.ok(r.errors.empresaId);
  assert.ok(r.errors.nome);
});

test('confirma importação, grava movimentos e atualiza saldo da conta quando extrato é mais novo', async () => {
  assert.equal(typeof contas.confirmarImportacao, 'function');
  const calls=[];
  const client={
    async query(sql, params){
      calls.push({sql,params});
      if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') return {rows:[]};
      if(sql.includes('FROM contas_bancarias') && sql.includes('FOR UPDATE')) return {rows:[{id:9,empresa_id:7,saldo_atual:'900.00',saldo_data:'2026-08-30'}]};
      if(sql.includes('FROM extrato_importacoes') && sql.includes('arquivo_hash')) return {rows:[]};
      if(sql.includes('INSERT INTO extrato_importacoes')) return {rows:[{id:44}]};
      if(sql.includes('INSERT INTO extrato_movimentos')) return {rows:[{id:1}]};
      if(sql.includes('UPDATE contas_bancarias')) return {rows:[]};
      if(sql.includes('UPDATE extrato_importacoes')) return {rows:[]};
      throw new Error('query inesperada: '+sql);
    }, release(){}
  };
  const pool={async connect(){return client;}};
  const r=await contas.confirmarImportacao({
    empresaId:7,contaBancariaId:9,nomeArquivo:'extrato.csv',arquivoHash:'abc',formato:'csv',
    saldoFinal:1200.25,saldoData:'2026-08-31',
    movimentos:[
      {data:'2026-08-31',tipo:'entrada',descricao:'PIX A',valor:500,fingerprint:'f1'},
      {data:'2026-08-31',tipo:'saida',descricao:'PIX B',valor:200,fingerprint:'f2'},
    ]
  }, pool);
  assert.equal(r.importacaoId,44);
  assert.equal(r.importadas,2);
  assert.equal(r.saldoAtualizado,true);
  const upd=calls.find(c=>c.sql.includes('UPDATE contas_bancarias'));
  assert.ok(upd);
  assert.equal(upd.params[0],1200.25);
});

test('extrato antigo nunca regride o saldo atual da conta', async () => {
  const calls=[];
  const client={
    async query(sql,params){
      calls.push({sql,params});
      if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') return {rows:[]};
      if(sql.includes('FROM contas_bancarias') && sql.includes('FOR UPDATE')) return {rows:[{id:9,empresa_id:7,saldo_atual:'1500.00',saldo_data:'2026-08-31'}]};
      if(sql.includes('FROM extrato_importacoes') && sql.includes('arquivo_hash')) return {rows:[]};
      if(sql.includes('INSERT INTO extrato_importacoes')) return {rows:[{id:45}]};
      if(sql.includes('INSERT INTO extrato_movimentos')) return {rows:[{id:1}]};
      if(sql.includes('UPDATE extrato_importacoes')) return {rows:[]};
      throw new Error('query inesperada: '+sql);
    },release(){}
  };
  const r=await contas.confirmarImportacao({empresaId:7,contaBancariaId:9,nomeArquivo:'old.csv',arquivoHash:'old',formato:'csv',saldoFinal:900,saldoData:'2026-08-25',movimentos:[]},{async connect(){return client;}});
  assert.equal(r.saldoAtualizado,false);
  assert.equal(calls.some(c=>c.sql.includes('UPDATE contas_bancarias')),false);
});

test('saldo bancário tem prioridade sobre saldo manual no fluxo', () => {
  assert.equal(typeof contas.resolverSaldoBase, 'function');
  const r = contas.resolverSaldoBase({valor:2500,dataReferencia:'2026-08-31',contasComSaldo:2,contasSemSaldo:0},{valor:1000,dataReferencia:'2026-08-01'});
  assert.equal(r.fonte,'bancario');
  assert.equal(r.valor,2500);
  const fallback = contas.resolverSaldoBase(null,{valor:1000,dataReferencia:'2026-08-01'});
  assert.equal(fallback.fonte,'manual');
});

test('reimportar o mesmo arquivo permite corrigir o saldo sem duplicar movimentos', async () => {
  const calls=[];
  const client={
    async query(sql,params){
      calls.push({sql,params});
      if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') return {rows:[]};
      if(sql.includes('FROM contas_bancarias') && sql.includes('FOR UPDATE')) return {rows:[{id:9,empresa_id:7,saldo_atual:'1000.00',saldo_data:'2026-08-31'}]};
      if(sql.includes('FROM extrato_importacoes') && sql.includes('arquivo_hash')) return {rows:[{id:77}]};
      if(sql.includes('UPDATE contas_bancarias')) return {rows:[]};
      if(sql.includes('UPDATE extrato_importacoes') && sql.includes('saldo_final')) return {rows:[]};
      throw new Error('query inesperada: '+sql);
    },release(){}
  };
  const r=await contas.confirmarImportacao({
    empresaId:7,contaBancariaId:9,nomeArquivo:'mesmo.pdf',arquivoHash:'mesmo',formato:'pdf',
    saldoFinal:1100,saldoData:'2026-08-31',movimentos:[{data:'2026-08-31',tipo:'entrada',descricao:'PIX',valor:100,fingerprint:'f1'}]
  },{async connect(){return client;}});
  assert.equal(r.jaImportado,true);
  assert.equal(r.importadas,0);
  assert.equal(r.saldoAtualizado,true);
  assert.ok(calls.some(c=>c.sql.includes('UPDATE contas_bancarias')));
  assert.ok(calls.some(c=>c.sql.includes('UPDATE extrato_importacoes') && c.sql.includes('saldo_final')));
  assert.equal(calls.some(c=>c.sql.includes('INSERT INTO extrato_movimentos')),false);
});

test('extrato com número de conta diferente da conta selecionada é bloqueado', async () => {
  const client={
    async query(sql){
      if(sql==='BEGIN'||sql==='ROLLBACK') return {rows:[]};
      if(sql.includes('FROM contas_bancarias') && sql.includes('FOR UPDATE')) return {rows:[{id:9,empresa_id:7,conta:'1111-1',saldo_atual:null,saldo_data:null}]};
      throw new Error('não deveria avançar para gravar o extrato');
    },release(){}
  };
  await assert.rejects(
    () => contas.confirmarImportacao({empresaId:7,contaBancariaId:9,nomeArquivo:'nubank.pdf',arquivoHash:'x',formato:'pdf',saldoFinal:100,saldoData:'2026-08-31',contaDetectada:'2222-2',movimentos:[]},{async connect(){return client;}}),
    /conta.*não corresponde/i
  );
});

test('bloqueia data de saldo inválida antes de gravar no banco', async () => {
  let conectou=false;
  await assert.rejects(
    () => contas.confirmarImportacao({empresaId:7,contaBancariaId:9,saldoFinal:100,saldoData:'31/99/2026',movimentos:[]},{async connect(){conectou=true;throw new Error('não deveria conectar');}}),
    /data.*saldo.*inválida/i
  );
  assert.equal(conectou,false);
});

test('bloqueia saldo final não numérico antes de gravar no banco', async () => {
  let conectou=false;
  await assert.rejects(
    () => contas.confirmarImportacao({empresaId:7,contaBancariaId:9,saldoFinal:'abc',saldoData:'2026-08-31',movimentos:[]},{async connect(){conectou=true;throw new Error('não deveria conectar');}}),
    /saldo final.*inválido/i
  );
  assert.equal(conectou,false);
});

test('extrato de banco diferente do banco selecionado é bloqueado quando ambos são conhecidos', async () => {
  const client={
    async query(sql){
      if(sql==='BEGIN'||sql==='ROLLBACK') return {rows:[]};
      if(sql.includes('FROM contas_bancarias') && sql.includes('FOR UPDATE')) return {rows:[{id:9,empresa_id:7,banco:'Mercado Pago',conta:null,saldo_atual:null,saldo_data:null}]};
      throw new Error('não deveria avançar para gravar o extrato');
    },release(){}
  };
  await assert.rejects(
    () => contas.confirmarImportacao({empresaId:7,contaBancariaId:9,nomeArquivo:'nubank.pdf',arquivoHash:'x',formato:'pdf',saldoFinal:100,saldoData:'2026-08-31',bancoDetectado:'Nubank',movimentos:[]},{async connect(){return client;}}),
    /banco.*não corresponde/i
  );
});
