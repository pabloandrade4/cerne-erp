const express = require('express');
const contas = require('../lib/contasBancarias');
const extrato = require('../lib/extratoBancario');

const router = express.Router();
function decodeArquivo(body){
  const nomeArquivo=String(body.nomeArquivo||'').trim();
  const base64=String(body.arquivoBase64||'').replace(/^data:[^;]+;base64,/, '');
  if(!nomeArquivo) throw new Error('Informe o nome do arquivo.');
  if(!base64) throw new Error('Envie o arquivo do extrato.');
  const buffer=Buffer.from(base64,'base64');
  if(!buffer.length) throw new Error('Arquivo vazio.');
  if(buffer.length > 10*1024*1024) throw new Error('O extrato deve ter no máximo 10 MB.');
  return {nomeArquivo,buffer};
}

router.get('/', async (req,res,next)=>{
  try{
    if(!req.query.empresaId) return res.status(400).json({error:'Informe empresaId.'});
    const [lista,saldo]=await Promise.all([
      contas.listarContasBancarias({empresaId:req.query.empresaId}),
      contas.saldoConsolidado(req.query.empresaId),
    ]);
    res.json({contas:lista,saldoConsolidado:saldo});
  }catch(err){next(err);}
});

router.post('/', async (req,res,next)=>{
  try{
    const r=await contas.criarContaBancaria(req.body);
    if(r.errors) return res.status(400).json({errors:r.errors});
    res.status(201).json(r);
  }catch(err){next(err);}
});

router.get('/movimentos', async (req,res,next)=>{
  try{
    if(!req.query.empresaId) return res.status(400).json({error:'Informe empresaId.'});
    const movimentos=await contas.listarMovimentos({empresaId:req.query.empresaId,contaBancariaId:req.query.contaBancariaId,limite:req.query.limite});
    res.json({movimentos});
  }catch(err){next(err);}
});

router.post('/importar/analisar', async (req,res,next)=>{
  try{
    const {nomeArquivo,buffer}=decodeArquivo(req.body);
    const a=await extrato.analisarArquivo({nomeArquivo,buffer});
    res.json({analise:{formato:a.formato,banco:a.banco,conta:a.conta,saldoFinal:a.saldoFinal,saldoData:a.saldoData,quantidadeMovimentos:a.movimentos.length,
      preview:a.movimentos.slice(0,20).map(({data,tipo,descricao,valor})=>({data,tipo,descricao,valor}))}});
  }catch(err){res.status(400).json({error:err.message||'Não foi possível analisar o extrato.'});}
});

router.post('/importar/confirmar', async (req,res,next)=>{
  try{
    const empresaId=Number(req.body.empresaId),contaBancariaId=Number(req.body.contaBancariaId);
    if(!empresaId||!contaBancariaId) return res.status(400).json({error:'Selecione a empresa e a conta bancária.'});
    const {nomeArquivo,buffer}=decodeArquivo(req.body);
    const a=await extrato.analisarArquivo({nomeArquivo,buffer});
    if(req.body.saldoFinal!==undefined && req.body.saldoFinal!==null && String(req.body.saldoFinal).trim()!==''){
      const manual=extrato.normalizarValor(req.body.saldoFinal);
      if(manual===null) return res.status(400).json({error:'Saldo final inválido.'});
      a.saldoFinal=manual;
    }
    if(req.body.saldoData) a.saldoData=String(req.body.saldoData);
    if(a.saldoFinal===null||a.saldoFinal===undefined||!a.saldoData){
      return res.status(400).json({error:'Não consegui identificar o saldo final e a data. Confira os campos antes de importar.'});
    }
    const forcarSubstituicaoSaldo = req.body.forcarSubstituicaoSaldo===true || req.body.forcarSubstituicaoSaldo==='true';
    const r=await contas.confirmarImportacao({empresaId,contaBancariaId,nomeArquivo,arquivoHash:a.arquivoHash,formato:a.formato,saldoFinal:a.saldoFinal,saldoData:a.saldoData,bancoDetectado:a.banco,contaDetectada:a.conta,movimentos:a.movimentos,forcarSubstituicaoSaldo});
    const saldoConsolidado=await contas.saldoConsolidado(empresaId);
    res.json({...r,saldoFinal:a.saldoFinal,saldoData:a.saldoData,saldoConsolidado});
  }catch(err){
    if(/obrigat|não encontrada|não corresponde|inválid|identificar|formato|PDF não reconhecido/i.test(err.message||'')) return res.status(400).json({error:err.message});
    next(err);
  }
});

// (31/08/2026) Ajustes finos num movimento do extrato — categoria,
// transferência interna, e conciliação manual com uma conta a pagar. Toda a
// regra (e a explicação de por que isso nunca duplica despesa na DRE) mora
// em lib/contasBancarias.js.
router.patch('/movimentos/:id/categoria', async (req,res,next)=>{
  try{
    if(!req.body.empresaId) return res.status(400).json({error:'Informe empresaId.'});
    const r=await contas.definirCategoriaMovimento(req.params.id, req.body.categoriaId||null, {empresaId:req.body.empresaId});
    if(r.notFound) return res.status(404).json({error:'Movimentação não encontrada.'});
    if(r.errors) return res.status(400).json({errors:r.errors});
    res.json(r);
  }catch(err){next(err);}
});

router.patch('/movimentos/:id/transferencia', async (req,res,next)=>{
  try{
    if(!req.body.empresaId) return res.status(400).json({error:'Informe empresaId.'});
    const r=await contas.marcarTransferenciaInterna(req.params.id, {empresaId:req.body.empresaId, transferenciaInterna:req.body.transferenciaInterna===true});
    if(r.notFound) return res.status(404).json({error:'Movimentação não encontrada.'});
    res.json(r);
  }catch(err){next(err);}
});

router.patch('/movimentos/:id/conciliar', async (req,res,next)=>{
  try{
    if(!req.body.empresaId) return res.status(400).json({error:'Informe empresaId.'});
    const r=await contas.vincularContaPagar(req.params.id, req.body.contaPagarId, {empresaId:req.body.empresaId});
    if(r.notFound) return res.status(404).json({error:'Movimentação não encontrada.'});
    if(r.errors) return res.status(400).json({errors:r.errors});
    res.json(r);
  }catch(err){next(err);}
});

router.patch('/movimentos/:id/desconciliar', async (req,res,next)=>{
  try{
    if(!req.body.empresaId) return res.status(400).json({error:'Informe empresaId.'});
    const r=await contas.desvincularContaPagar(req.params.id, {empresaId:req.body.empresaId});
    if(r.notFound) return res.status(404).json({error:'Movimentação não encontrada.'});
    res.json(r);
  }catch(err){next(err);}
});

module.exports=router;
