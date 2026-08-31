function poolPadrao(){ return require('../db/pool'); }
const { dataCalendarioISO } = require('./periodo');
const { normalizarData } = require('./contasPagarImportacao');

function round2(n){ return Math.round(Number(n)*100)/100; }
function isoData(v){ return v ? dataCalendarioISO(v) : null; }
function soDigitos(v){ return String(v||'').replace(/\D/g,''); }
function bancoNormalizado(v){ const s=String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,''); if(s.includes('nubank')||s.includes('nupagamentos')||s.includes('nufinanceira')) return 'nubank'; if(s.includes('mercadopago')) return 'mercadopago'; return s; }


function resolverSaldoBase(saldoBancario, saldoManual){
  if(saldoBancario && saldoBancario.valor!==null && saldoBancario.valor!==undefined){
    return {...saldoBancario, fonte:'bancario'};
  }
  if(saldoManual && saldoManual.valor!==null && saldoManual.valor!==undefined){
    return {...saldoManual, fonte:'manual'};
  }
  return null;
}

async function listarContasBancarias({empresaId}, db=null){
  const id=Number(empresaId); if(!id) return [];
  db = db || poolPadrao();
  const {rows}=await db.query(`SELECT id, empresa_id, nome, banco, agencia, conta, ativo, saldo_atual, saldo_data, saldo_atualizado_em
    FROM contas_bancarias WHERE empresa_id=$1 ORDER BY ativo DESC, nome`,[id]);
  return rows.map(r=>({id:Number(r.id),empresaId:Number(r.empresa_id),nome:r.nome,banco:r.banco,agencia:r.agencia,conta:r.conta,ativo:r.ativo!==false,
    saldoAtual:r.saldo_atual===null?null:Number(r.saldo_atual),saldoData:isoData(r.saldo_data),saldoAtualizadoEm:r.saldo_atualizado_em||null}));
}

async function saldoConsolidado(empresaId, db=null){
  const id=Number(empresaId); if(!id) return null;
  db = db || poolPadrao();
  let rows;
  try {
    ({rows}=await db.query(`SELECT id, nome, banco, ativo, saldo_atual, saldo_data FROM contas_bancarias WHERE empresa_id=$1 ORDER BY nome`,[id]));
  } catch (err) {
    // O módulo bancário não pode derrubar o Fluxo de Caixa inteiro durante
    // um deploy/migração. Em bancos antigos, a tabela pode existir sem as
    // colunas de saldo adicionadas na ML39. Nessa janela usamos o fallback
    // de saldo manual (ou "não informado") e o próximo boot/migrate corrige
    // a estrutura com ALTER ... ADD COLUMN IF NOT EXISTS no schema.sql.
    if (err && (err.code === '42P01' || err.code === '42703')) {
      console.warn('[contas-bancarias] schema bancário ainda não compatível; fluxo seguirá sem saldo bancário:', err.message);
      return null;
    }
    throw err;
  }
  const ativas=rows.filter(r=>r.ativo!==false);
  const conhecidas=ativas.filter(r=>r.saldo_atual!==null&&r.saldo_atual!==undefined&&r.saldo_data);
  if(!conhecidas.length) return null;
  const valor=round2(conhecidas.reduce((s,r)=>s+Number(r.saldo_atual),0));
  const datas=conhecidas.map(r=>isoData(r.saldo_data)).filter(Boolean).sort();
  return {valor,dataReferencia:datas[datas.length-1]||null,contasComSaldo:conhecidas.length,contasSemSaldo:ativas.length-conhecidas.length,
    contas:conhecidas.map(r=>({id:Number(r.id),nome:r.nome,banco:r.banco,saldoAtual:Number(r.saldo_atual),saldoData:isoData(r.saldo_data)}))};
}

async function criarContaBancaria(body, db=null){
  const errors={}; const empresaId=Number(body.empresaId); const nome=String(body.nome||'').trim();
  if(!empresaId) errors.empresaId='Selecione a empresa.'; if(!nome) errors.nome='Informe o nome da conta.';
  if(Object.keys(errors).length) return {errors};
  db = db || poolPadrao();
  const banco=String(body.banco||'').trim()||null, agencia=String(body.agencia||'').trim()||null, conta=String(body.conta||'').trim()||null;
  const {rows}=await db.query(`INSERT INTO contas_bancarias (empresa_id,nome,banco,agencia,conta) VALUES ($1,$2,$3,$4,$5) RETURNING *`,[empresaId,nome,banco,agencia,conta]);
  const r=rows[0]; return {conta:{id:Number(r.id),empresaId:Number(r.empresa_id),nome:r.nome,banco:r.banco,agencia:r.agencia,conta:r.conta,ativo:r.ativo!==false,saldoAtual:r.saldo_atual===null?null:Number(r.saldo_atual),saldoData:isoData(r.saldo_data)}};
}

async function confirmarImportacao(payload, pool=null){
  const empresaId=Number(payload.empresaId), contaBancariaId=Number(payload.contaBancariaId);
  if(!empresaId||!contaBancariaId) throw new Error('Empresa e conta bancária são obrigatórias.');
  const saldoDataNormalizada = payload.saldoData ? normalizarData(payload.saldoData) : null;
  if(payload.saldoData && !saldoDataNormalizada) throw new Error('A data do saldo final é inválida.');
  const temSaldoFinal = payload.saldoFinal!==null && payload.saldoFinal!==undefined && payload.saldoFinal!=='';
  const saldoFinalNumero = temSaldoFinal ? Number(payload.saldoFinal) : null;
  if(temSaldoFinal && !Number.isFinite(saldoFinalNumero)) throw new Error('O saldo final é inválido.');
  pool = pool || poolPadrao();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows:contas}=await client.query('SELECT id, empresa_id, banco, conta, saldo_atual, saldo_data FROM contas_bancarias WHERE id=$1 AND empresa_id=$2 FOR UPDATE',[contaBancariaId,empresaId]);
    if(!contas.length) throw new Error('Conta bancária não encontrada para esta empresa.');
    const conta=contas[0];
    const bancoCadastrado=bancoNormalizado(conta.banco);
    const bancoDetectado=bancoNormalizado(payload.bancoDetectado);
    if(bancoCadastrado && bancoDetectado && bancoCadastrado!==bancoDetectado){
      throw new Error('O banco detectado no extrato não corresponde ao banco da conta selecionada. Confira a conta antes de importar.');
    }
    const contaCadastrada=soDigitos(conta.conta);
    const contaDetectada=soDigitos(payload.contaDetectada);
    if(contaCadastrada && contaDetectada && contaCadastrada!==contaDetectada){
      throw new Error('A conta detectada no extrato não corresponde à conta bancária selecionada. Confira a conta antes de importar.');
    }
    const hash=String(payload.arquivoHash||'').trim();
    if(hash){
      const {rows:ja}=await client.query('SELECT id FROM extrato_importacoes WHERE conta_bancaria_id=$1 AND arquivo_hash=$2 LIMIT 1',[contaBancariaId,hash]);
      if(ja.length){
        const importacaoId=Number(ja[0].id);
        let saldoAtualizado=false;
        if(temSaldoFinal&&saldoDataNormalizada){
          await client.query('UPDATE extrato_importacoes SET saldo_final=$1, saldo_data=$2 WHERE id=$3',[saldoFinalNumero,saldoDataNormalizada,importacaoId]);
          const saldoDataAtual=isoData(conta.saldo_data);
          if(!saldoDataAtual || String(saldoDataNormalizada)>=saldoDataAtual){
            await client.query(`UPDATE contas_bancarias SET saldo_atual=$1,saldo_data=$2,saldo_atualizado_em=now(),updated_at=now() WHERE id=$3`,[saldoFinalNumero,saldoDataNormalizada,contaBancariaId]);
            saldoAtualizado=true;
          }
        }
        await client.query('COMMIT');
        return {jaImportado:true,importacaoId,importadas:0,duplicidades:0,saldoAtualizado};
      }
    }
    const {rows:impRows}=await client.query(`INSERT INTO extrato_importacoes
      (empresa_id,conta_bancaria_id,arquivo_nome,arquivo_hash,formato,saldo_final,saldo_data,quantidade_movimentos,quantidade_importada,quantidade_duplicada)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0) RETURNING id`,[
        empresaId,contaBancariaId,String(payload.nomeArquivo||'extrato'),hash||null,String(payload.formato||'').slice(0,20)||null,
        temSaldoFinal?saldoFinalNumero:null,saldoDataNormalizada,(payload.movimentos||[]).length
      ]);
    const importacaoId=Number(impRows[0].id); let importadas=0,duplicidades=0;
    for(const m of (payload.movimentos||[])){
      const {rows}=await client.query(`INSERT INTO extrato_movimentos
        (importacao_id,empresa_id,conta_bancaria_id,data,descricao,tipo,valor,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (conta_bancaria_id,fingerprint) DO NOTHING RETURNING id`,[
          importacaoId,empresaId,contaBancariaId,m.data,String(m.descricao||'Movimentação bancária').slice(0,500),m.tipo,Number(m.valor),m.fingerprint
        ]);
      if(rows.length) importadas++; else duplicidades++;
    }
    let saldoAtualizado=false;
    if(temSaldoFinal&&saldoDataNormalizada){
      const saldoDataAtual=isoData(conta.saldo_data);
      if(!saldoDataAtual || String(saldoDataNormalizada)>=saldoDataAtual){
        await client.query(`UPDATE contas_bancarias SET saldo_atual=$1,saldo_data=$2,saldo_atualizado_em=now(),updated_at=now() WHERE id=$3`,[saldoFinalNumero,saldoDataNormalizada,contaBancariaId]);
        saldoAtualizado=true;
      }
    }
    await client.query('UPDATE extrato_importacoes SET quantidade_importada=$1, quantidade_duplicada=$2 WHERE id=$3',[importadas,duplicidades,importacaoId]);
    await client.query('COMMIT');
    return {jaImportado:false,importacaoId,importadas,duplicidades,saldoAtualizado};
  }catch(err){ try{await client.query('ROLLBACK');}catch(_){} throw err; }
  finally{ client.release(); }
}

async function listarMovimentos({empresaId,contaBancariaId,limite=100}, db=null){
  db = db || poolPadrao();
  const params=[Number(empresaId)]; let where='empresa_id=$1';
  if(Number(contaBancariaId)){params.push(Number(contaBancariaId));where+=` AND conta_bancaria_id=$${params.length}`;}
  params.push(Math.min(Math.max(Number(limite)||100,1),500));
  const {rows}=await db.query(`SELECT id,conta_bancaria_id,data,descricao,tipo,valor,conciliado,created_at FROM extrato_movimentos WHERE ${where} ORDER BY data DESC,id DESC LIMIT $${params.length}`,params);
  return rows.map(r=>({id:Number(r.id),contaBancariaId:Number(r.conta_bancaria_id),data:isoData(r.data),descricao:r.descricao,tipo:r.tipo,valor:Number(r.valor),conciliado:!!r.conciliado,createdAt:r.created_at}));
}

module.exports={resolverSaldoBase,listarContasBancarias,saldoConsolidado,criarContaBancaria,confirmarImportacao,listarMovimentos};
