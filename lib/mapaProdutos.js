// Mapa de Produtos — identificação de produto FÍSICO a partir de texto livre
// (Etapa (b) da tarefa "IA Gestora que conhece o negócio", 27/08/2026, ver
// docs/02-decisoes.md e docs/PROPOSTA-contexto-negocio-ia-gestora.md).
//
// Por que este arquivo existe e por que fica FORA de lib/ia/ (decisão do
// usuário, ver docs/02-decisoes.md, tarefa acima, ponto 1 — convenção de
// nomes aprovada): identificar um produto físico a partir de um texto
// (código, apelido ou medida) não é uma regra exclusiva da IA — é uma
// capacidade do próprio Mapa de Produtos (routes/produtosBase.js,
// public/index.html > Mapa de Produtos), reaproveitável por qualquer parte
// do ERP que precise "traduzir" um texto em um produto base cadastrado. A
// IA Gestora só CONSOME esta função através de uma ferramenta fina em
// lib/ia/ferramentas.js (identificar_produto_fisico) — nenhuma regra nova
// é criada aqui além da própria busca.
//
// REGRA CENTRAL (a mesma "nunca inventar/nunca resolver ambiguidade
// sozinho" de toda a IA Gestora, ver lib/ia/ferramentas.js): esta função
// NUNCA escolhe sozinha entre dois produtos candidatos igualmente
// prováveis — ela sempre devolve um dos 3 status abaixo, nunca "chuta" um
// deles:
//   - 'identificado'    → exatamente 1 produto encontrado (por código,
//                          apelido ou medida, nessa ordem — a primeira
//                          camada que encontrar QUALQUER candidato já
//                          decide o status, sem cair pras camadas
//                          seguintes, pra um código nunca perder pra uma
//                          medida parecida).
//   - 'ambiguo'          → mais de um produto bate com o texto (nenhuma das
//                          3 buscas exatas encontrou nada sozinha — só a
//                          busca aproximada final encontrou vários) — quem
//                          decide qual é o certo é sempre o usuário, nunca
//                          a IA.
//   - 'nao_encontrado'   → nenhum produto bate, nem de forma aproximada.
const pool = require('../db/pool');

const LIMITE_CANDIDATOS = 8;

function serializeProdutoBase(row) {
  return {
    id: row.id,
    codigo: row.codigo,
    nome: row.nome,
    medida: row.medida,
    categoria: row.categoria,
    ativo: row.ativo,
  };
}

const CAMPOS_SELECT = 'id, codigo, nome, medida, categoria, ativo';

// Camada 1 — código EXATO (case-insensitive, ignorando espaço nas pontas).
// Código é o identificador mais forte do cadastro (UNIQUE por empresa em
// produtos_base) — se bater um código, a busca já para aqui, mesmo que o
// mesmo texto também pareça uma medida de outro produto.
async function buscarPorCodigoExato(empresaId, texto) {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_SELECT} FROM produtos_base WHERE empresa_id = $1 AND UPPER(TRIM(codigo)) = UPPER(TRIM($2))`,
    [empresaId, texto]
  );
  return rows;
}

// Camada 2 — apelido (produto_base_aliases.alias) EXATO — mesma tabela e
// regra já usada pela tela Mapa de Produtos > Apelidos (routes/produtosBase.js).
const CAMPOS_SELECT_QUALIFICADO = CAMPOS_SELECT.split(', ').map((c) => 'pb.' + c).join(', ');

async function buscarPorApelidoExato(empresaId, texto) {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_SELECT_QUALIFICADO} FROM produtos_base pb
     JOIN produto_base_aliases a ON a.produto_base_id = pb.id
     WHERE pb.empresa_id = $1 AND UPPER(TRIM(a.alias)) = UPPER(TRIM($2))`,
    [empresaId, texto]
  );
  return rows;
}

// Camada 3 — medida EXATA (ex: usuário digita "20x20x20" e o produto tem
// medida "20X20X20" cadastrada, mesmo sem código/apelido batendo).
async function buscarPorMedidaExata(empresaId, texto) {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_SELECT} FROM produtos_base WHERE empresa_id = $1 AND medida IS NOT NULL AND UPPER(TRIM(medida)) = UPPER(TRIM($2))`,
    [empresaId, texto]
  );
  return rows;
}

// Camada 4 — busca aproximada (ILIKE) em código, nome, medida e apelidos —
// só usada quando NENHUMA das 3 buscas exatas encontrou nada. Pode devolver
// vários candidatos (status 'ambiguo') ou nenhum ('nao_encontrado') — nunca
// escolhe um sozinha.
async function buscarAproximado(empresaId, texto) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ${CAMPOS_SELECT_QUALIFICADO} FROM produtos_base pb
     LEFT JOIN produto_base_aliases a ON a.produto_base_id = pb.id
     WHERE pb.empresa_id = $1 AND (
       pb.codigo ILIKE '%' || $2 || '%'
       OR pb.nome ILIKE '%' || $2 || '%'
       OR pb.medida ILIKE '%' || $2 || '%'
       OR a.alias ILIKE '%' || $2 || '%'
     )
     ORDER BY pb.codigo
     LIMIT ${LIMITE_CANDIDATOS + 1}`,
    [empresaId, texto]
  );
  return rows;
}

// `textoLivre`: o jeito como o usuário se referiu ao produto na pergunta
// (ex: "caixa 20x20x20", "CX-19X12X12", um apelido cadastrado). Nunca
// recebe empresaId do texto/modelo — sempre o `ctx.empresaId` estrutural
// (mesma regra de todas as outras ferramentas, ver lib/ia/ferramentas.js).
async function identificarProdutoFisico(empresaId, textoLivre) {
  const texto = String(textoLivre || '').trim();
  if (!texto) {
    return { status: 'nao_encontrado', textoConsultado: texto, produto: null, candidatos: [], camadaEncontrada: null };
  }

  const camadas = [
    ['codigo', buscarPorCodigoExato],
    ['apelido', buscarPorApelidoExato],
    ['medida', buscarPorMedidaExata],
  ];

  for (const [nomeCamada, buscar] of camadas) {
    const encontrados = await buscar(empresaId, texto);
    if (!encontrados.length) continue;
    if (encontrados.length === 1) {
      return { status: 'identificado', textoConsultado: texto, produto: serializeProdutoBase(encontrados[0]), candidatos: [], camadaEncontrada: nomeCamada };
    }
    // Mais de um produto com o MESMO código/apelido/medida exatos não
    // deveria acontecer (código e apelido são UNIQUE por empresa) — mas
    // medida não é única, então isso é alcançável ali. Nunca escolhe um:
    // devolve ambíguo, mesmo camada exata.
    return {
      status: 'ambiguo',
      textoConsultado: texto,
      produto: null,
      candidatos: encontrados.slice(0, LIMITE_CANDIDATOS).map(serializeProdutoBase),
      camadaEncontrada: nomeCamada,
    };
  }

  const aproximados = await buscarAproximado(empresaId, texto);
  if (!aproximados.length) {
    return { status: 'nao_encontrado', textoConsultado: texto, produto: null, candidatos: [], camadaEncontrada: null };
  }
  if (aproximados.length === 1) {
    return { status: 'identificado', textoConsultado: texto, produto: serializeProdutoBase(aproximados[0]), candidatos: [], camadaEncontrada: 'aproximado' };
  }
  return {
    status: 'ambiguo',
    textoConsultado: texto,
    produto: null,
    candidatos: aproximados.slice(0, LIMITE_CANDIDATOS).map(serializeProdutoBase),
    listaTruncada: aproximados.length > LIMITE_CANDIDATOS,
    camadaEncontrada: 'aproximado',
  };
}

module.exports = { identificarProdutoFisico, serializeProdutoBase };
