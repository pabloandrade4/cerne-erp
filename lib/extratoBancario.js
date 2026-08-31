const crypto = require('node:crypto');
const { normalizarData } = require('./contasPagarImportacao');

function round2(n){ return Math.round(Number(n) * 100) / 100; }
function slug(s){ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,' ').trim(); }

function normalizarValor(valor){
  if(valor===null||valor===undefined||valor==='') return null;
  if(typeof valor==='number') return Number.isFinite(valor) ? round2(valor) : null;
  let s=String(valor).trim().replace(/\s/g,'').replace(/^R\$/i,'');
  if(!s) return null;
  const par=/^\(.*\)$/.test(s); if(par) s=s.slice(1,-1);
  if(s.includes(',')&&s.includes('.')){
    if(s.lastIndexOf(',')>s.lastIndexOf('.')) s=s.replace(/\./g,'').replace(',','.');
    else s=s.replace(/,/g,'');
  } else if(s.includes(',')) s=s.replace(/\./g,'').replace(',','.');
  else if(/^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) s=s.replace(/\./g,'');
  const n=Number(s); if(!Number.isFinite(n)) return null;
  return round2(par ? -n : n);
}

function detectarDelimitador(texto){
  const linha=String(texto||'').split(/\r?\n/).find(x=>x.trim())||'';
  const cs=[';',',','\t']; let best=';', max=-1;
  for(const d of cs){ let count=0, q=false; for(let i=0;i<linha.length;i++){ const c=linha[i]; if(c==='"'){ if(q&&linha[i+1]==='"') i++; else q=!q; } else if(!q&&c===d) count++; } if(count>max){max=count;best=d;} }
  return best;
}
function parseCsv(texto,d){
  const out=[]; let row=[],field='',q=false; const s=String(texto||'').replace(/^\uFEFF/,'');
  for(let i=0;i<s.length;i++){ const c=s[i]; if(q){ if(c==='"'&&s[i+1]==='"'){field+='"';i++;} else if(c==='"')q=false; else field+=c; }
    else if(c==='"')q=true; else if(c===d){row.push(field);field='';} else if(c==='\n'){row.push(field.replace(/\r$/,''));field='';if(row.some(v=>String(v).trim()))out.push(row);row=[];} else field+=c; }
  if(field||row.length){row.push(field.replace(/\r$/,''));if(row.some(v=>String(v).trim()))out.push(row);} return out;
}
function acharColuna(headers,aliases){ const hs=headers.map(h=>({h,s:slug(h)})); const as=aliases.map(slug); return (hs.find(x=>as.includes(x.s))||{}).h||null; }

function lerCsvBuffer(buffer){
  const texto=Buffer.isBuffer(buffer)?buffer.toString('utf8'):String(buffer||''); const d=detectarDelimitador(texto); const m=parseCsv(texto,d);
  if(!m.length) return {movimentos:[],saldoFinal:null,saldoData:null,banco:null,conta:null};
  const h=m[0].map(x=>String(x||'').trim());
  const cData=acharColuna(h,['data','date']);
  const cNatureza=acharColuna(h,['natureza','tipo movimento','entrada saida','movimento']);
  const cTipo=acharColuna(h,['tipo','categoria']);
  const cDesc=acharColuna(h,['descricao','descrição','historico','histórico','detalhes','detalhe']);
  const cValor=acharColuna(h,['valor','valor r$','valor (r$)','amount']);
  const cSaldo=acharColuna(h,['saldo','saldo r$','saldo (r$)','balance','saldo final']);
  const rows=m.slice(1).map(vals=>Object.fromEntries(h.map((k,i)=>[k,vals[i]??''])));
  const movimentos=[]; let saldoFinal=null,saldoData=null;
  for(const r of rows){
    const data=cData?normalizarData(r[cData]):null; const valor=cValor?normalizarValor(r[cValor]):null;
    if(data && valor!==null && Math.abs(valor)>0){
      const nat=slug(cNatureza?r[cNatureza]:'');
      let tipo=valor<0?'saida':'entrada'; if(nat.includes('saida')) tipo='saida'; else if(nat.includes('entrada')) tipo='entrada';
      const descricao=String((cDesc&&r[cDesc])||(cTipo&&r[cTipo])||'Movimentação bancária').trim();
      movimentos.push({data,tipo,descricao,valor:Math.abs(round2(valor))});
    }
    if(data&&cSaldo){ const s=normalizarValor(r[cSaldo]); if(s!==null){ saldoFinal=s; saldoData=data; } }
  }
  return { movimentos, saldoFinal, saldoData, banco:null, conta:null };
}

const MESES={janeiro:1,fevereiro:2,marco:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12,
  jan:1,fev:2,mar:3,abr:4,mai:5,jun:6,jul:7,ago:8,set:9,out:10,nov:11,dez:12};
function isoPt(d,mes,ano){ const mm=MESES[slug(mes)]; if(!mm)return null; return `${ano}-${String(mm).padStart(2,'0')}-${String(Number(d)).padStart(2,'0')}`; }

function analisarTextoPdfNubank(texto){
  const raw=String(texto||'').replace(/\u00a0/g,' ');
  const periodo=/\b(\d{1,2})\s+DE\s+([A-ZÇÃÉ]+)\s+DE\s+(\d{4})\s+a\s+(\d{1,2})\s+DE\s+([A-ZÇÃÉ]+)\s+DE\s+(\d{4})/i.exec(raw);
  const saldoData=periodo?isoPt(periodo[4],periodo[5],periodo[6]):null;
  let saldoFinal=null;
  let mm=/Saldo final do per[ií]odo\s*(?:\r?\n|\s)+(?:R\$\s*)?([+-]?[\d.]+,\d{2})/i.exec(raw);
  if(mm) saldoFinal=normalizarValor(mm[1]);
  const contaM=/Ag[eê]ncia\s*0*001\s+Conta\s*[\r\n ]+([\d-]+)/i.exec(raw) || /Conta\s*[: ]\s*([\d-]{6,})/i.exec(raw);
  const conta=contaM?contaM[1]:null;
  const lines=raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const movimentos=[]; let diaAtual=null;
  for(const line of lines){
    const dm=/^(\d{1,2})\s+([A-ZÇÃÉ]{3})\s+(\d{4})\b/i.exec(line); if(dm){ diaAtual=isoPt(dm[1],dm[2],dm[3]); }
    if(!diaAtual) continue;
    if(/Total de (entradas|sa[ií]das)|Saldo do dia|Saldo inicial|Saldo final|Rendimento/i.test(line)) continue;
    const vm=/([\d.]+,\d{2})\s*$/.exec(line); if(!vm) continue;
    const valor=normalizarValor(vm[1]); if(valor===null) continue;
    const prefix=line.slice(0,vm.index).trim(); const ps=slug(prefix);
    let tipo=null;
    if(/recebid|entrada|resgate/.test(ps)) tipo='entrada';
    else if(/enviad|pagamento|boleto|aplicacao|saida|tarifa|compra/.test(ps)) tipo='saida';
    if(!tipo) continue;
    movimentos.push({data:diaAtual,tipo,descricao:prefix.replace(/\s+/g,' ').trim()||'Movimentação bancária',valor:Math.abs(valor)});
  }
  return { banco:'Nubank', conta, saldoFinal, saldoData, movimentos };
}


async function lerXlsxBuffer(buffer, deps={}){
  const ExcelJS = deps.ExcelJS || require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if(!ws) return {movimentos:[],saldoFinal:null,saldoData:null,banco:null,conta:null};
  const headers=[]; for(let c=1;c<=ws.columnCount;c++){ const v=ws.getRow(1).getCell(c).value; headers.push(String(v??'').trim()||`Coluna ${c}`); }
  const rows=[];
  for(let r=2;r<=ws.rowCount;r++){ const obj={}; headers.forEach((h,i)=>{ let v=ws.getRow(r).getCell(i+1).value; if(v&&typeof v==='object'&&'result' in v)v=v.result; if(v&&typeof v==='object'&&'text' in v)v=v.text; obj[h]=v??''; }); rows.push(obj); }
  const cData=acharColuna(headers,['data','date']);
  const cNatureza=acharColuna(headers,['natureza','tipo movimento','entrada saida','movimento']);
  const cTipo=acharColuna(headers,['tipo','categoria']);
  const cDesc=acharColuna(headers,['descricao','descrição','historico','histórico','detalhes','detalhe']);
  const cValor=acharColuna(headers,['valor','valor r$','valor (r$)','amount']);
  const cSaldo=acharColuna(headers,['saldo','saldo r$','saldo (r$)','balance','saldo final']);
  const movimentos=[]; let saldoFinal=null,saldoData=null;
  for(const r of rows){
    const data=cData?normalizarData(r[cData]):null; const valor=cValor?normalizarValor(r[cValor]):null;
    if(data&&valor!==null&&Math.abs(valor)>0){ const nat=slug(cNatureza?r[cNatureza]:''); let tipo=valor<0?'saida':'entrada'; if(nat.includes('saida'))tipo='saida'; else if(nat.includes('entrada'))tipo='entrada'; const descricao=String((cDesc&&r[cDesc])||(cTipo&&r[cTipo])||'Movimentação bancária').trim(); movimentos.push({data,tipo,descricao,valor:Math.abs(round2(valor))}); }
    if(data&&cSaldo){const sv=normalizarValor(r[cSaldo]);if(sv!==null){saldoFinal=sv;saldoData=data;}}
  }
  return {movimentos,saldoFinal,saldoData,banco:null,conta:null};
}

async function analisarArquivo({nomeArquivo,buffer}, deps={}){
  if(!Buffer.isBuffer(buffer)) buffer=Buffer.from(buffer||'');
  const ext=String(nomeArquivo||'').toLowerCase().split('.').pop();
  let analise, formato;
  if(ext==='csv'||ext==='txt'){ formato='csv'; analise=lerCsvBuffer(buffer); }
  else if(ext==='xlsx'){ formato='xlsx'; analise=await lerXlsxBuffer(buffer,deps); }
  else if(ext==='pdf'){
    formato='pdf';
    const pdfParse=deps.pdfParse || require('pdf-parse');
    const parsed=await pdfParse(buffer);
    const texto=String(parsed.text||'');
    if(!/(?:Nu\s+Pagamentos|Nu\s+Financeira|Nubank)/i.test(texto)){
      throw new Error('PDF não reconhecido. Hoje o importador de PDF reconhece o formato de extrato do Nubank; para outros bancos, use CSV ou XLSX.');
    }
    analise=analisarTextoPdfNubank(texto);
    if(!analise.saldoData && !analise.movimentos.length) throw new Error('PDF não reconhecido. Hoje o importador de PDF reconhece o formato de extrato do Nubank.');
  } else throw new Error('Formato não suportado. Use PDF, CSV ou XLSX.');
  const arquivoHash=crypto.createHash('sha256').update(buffer).digest('hex');
  return {...analise,formato,arquivoHash,movimentos:adicionarFingerprints(analise.movimentos||[])};
}

function adicionarFingerprints(movimentos){
  const ocorrencias=new Map();
  return (movimentos||[]).map(m=>{
    const base=[m.data,m.tipo,slug(m.descricao),Number(m.valor).toFixed(2)].join('|');
    const n=(ocorrencias.get(base)||0)+1; ocorrencias.set(base,n);
    const fingerprint=crypto.createHash('sha256').update(base+'|'+n).digest('hex');
    return {...m,fingerprint};
  });
}

module.exports={ normalizarValor, lerCsvBuffer, lerXlsxBuffer, analisarTextoPdfNubank, analisarArquivo, adicionarFingerprints, slug };
