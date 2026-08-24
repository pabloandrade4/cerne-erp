// Tela Estoque (nova) — estoque físico agrupado por PRODUTO BASE, nunca por
// SKU de venda (ver server/lib/produtoBaseConversao.js). Três origens:
//   Galpão -> tabela estoque_produto_base (ajuste manual, aqui neste arquivo)
//   Full   -> busca ao vivo na API do Mercado Livre (lib/mlFull.js), convertida
//             de "quantidade de kits no Full" para "quantidade física" usando
//             o mesmo vínculo SKU -> produto base -> multiplicador das vendas.
// Nunca inventa: SKU sem vínculo salvo, item Full sem SKU, item Full sem
// quantidade disponível na API, ou custo não cadastrado no produto base —
// tudo isso fica em `pendentes` / com valor `null`, nunca vira 0 ou é somado
// como se fosse um número real.
const express = require('express');
const pool = require('../db/pool');
const { converterItens } = require('../lib/produtoBaseConversao');
const { buscarEstoqueFullCompletoDaConta } = require('../lib/mlFull');

const router = express.Router();

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Busca todos os produtos base da empresa (ativos e inativos — um produto
// base inativo pode ainda ter estoque real parado no Galpão, e esse
// estoque nunca deve simplesmente sumir da tela) com a quantidade em
// estoque no Galpão (0 quando nunca houve ajuste — quantidade em Galpão é
// sempre um número real, nunca "pendente", pois é controlada só por nós).
async function buscarGalpaoPorProdutoBase(empresaId) {
  const { rows } = await pool.query(
    `SELECT pb.id AS produto_base_id, pb.codigo, pb.nome, pb.custo, pb.ativo,
            COALESCE(epb.quantidade, 0) AS quantidade_galpao
     FROM produtos_base pb
     LEFT JOIN estoque_produto_base epb ON epb.produto_base_id = pb.id
     WHERE pb.empresa_id = $1
     ORDER BY pb.codigo`,
    [empresaId]
  );
  return rows;
}

// Busca o estoque Full da conta do Mercado Livre da empresa, já convertido
// para quantidade física por produto base. Mesmo contrato de pendência de
// routes/estoqueFull.js (pendente + motivo + mensagem) quando não há conta,
// a conta está com erro, ou a API falha.
async function buscarFullPorProdutoBase(empresaId) {
  const { rows: contas } = await pool.query(
    `SELECT * FROM ml_contas WHERE empresa_id = $1 ORDER BY created_at DESC`,
    [empresaId]
  );

  if (!contas.length) {
    return {
      consultado: false,
      pendente: true,
      motivo: 'sem_conta',
      mensagem: 'Nenhuma conta do Mercado Livre conectada para esta empresa. Conecte em Marketplaces para ver o estoque Full aqui.',
      conta: null,
      porProdutoBase: [],
      pendentes: { skusNaoMapeados: [], semQuantidade: [], semSku: [] },
      truncado: false,
    };
  }

  const conta = contas[0];
  if (conta.status !== 'ativa') {
    return {
      consultado: false,
      pendente: true,
      motivo: 'conta_com_erro',
      mensagem: 'A conexão desta conta com o Mercado Livre está com erro ou desconectada. Reconecte em Marketplaces para ver o estoque Full aqui.',
      conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
      porProdutoBase: [],
      pendentes: { skusNaoMapeados: [], semQuantidade: [], semSku: [] },
      truncado: false,
    };
  }

  try {
    const resultado = await buscarEstoqueFullCompletoDaConta(conta.id);

    const comQuantidade = [];
    const semQuantidade = [];
    const semSku = [];
    resultado.itens.forEach((item) => {
      if (!item.sku) {
        semSku.push({ id: item.id, titulo: item.titulo });
        return;
      }
      if (item.pendenteQuantidade || item.quantidadeFull === null) {
        semQuantidade.push({ id: item.id, titulo: item.titulo, sku: item.sku, motivo: item.motivoPendenciaQuantidade });
        return;
      }
      comQuantidade.push({ sku: item.sku, quantidade: item.quantidadeFull, id: item.id, titulo: item.titulo });
    });

    const conversao = await converterItens(empresaId, comQuantidade);

    // converterItens agrega `pendentes` por SKU não vinculado (soma quantidade
    // de kits, não física, já que sem vínculo não dá pra converter) — aqui
    // devolvemos o detalhe (id/título) além do total por SKU.
    const skusNaoMapeados = conversao.pendentes.map((p) => {
      const detalhe = comQuantidade.find((it) => it.sku === p.sku);
      return { sku: p.sku, quantidadeKits: p.quantidade, id: detalhe ? detalhe.id : null, titulo: detalhe ? detalhe.titulo : null };
    });

    return {
      consultado: true,
      pendente: false,
      motivo: null,
      mensagem: null,
      conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
      porProdutoBase: conversao.porProdutoBase,
      pendentes: { skusNaoMapeados, semQuantidade, semSku },
      truncado: resultado.truncado,
    };
  } catch (err) {
    return {
      consultado: false,
      pendente: true,
      motivo: 'erro_api',
      mensagem: 'Não foi possível buscar o estoque Full agora (' + (err.message || 'erro na API do Mercado Livre') + '). Tente novamente em instantes.',
      conta: { id: conta.id, nickname: conta.nickname, status: conta.status },
      porProdutoBase: [],
      pendentes: { skusNaoMapeados: [], semQuantidade: [], semSku: [] },
      truncado: false,
    };
  }
}

// GET /api/estoque-produto-base?empresaId=ID&filtro=todos|galpao|full
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    const filtro = ['todos', 'galpao', 'full'].includes(req.query.filtro) ? req.query.filtro : 'todos';
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const galpaoRows = await buscarGalpaoPorProdutoBase(empresaId);

    // A busca no Full percorre a conta inteira do Mercado Livre (várias
    // chamadas paginadas) — só vale o custo quando o filtro realmente
    // precisa desse dado.
    const precisaFull = filtro === 'todos' || filtro === 'full';
    const full = precisaFull
      ? await buscarFullPorProdutoBase(empresaId)
      : {
          consultado: false, pendente: false, motivo: 'nao_consultado',
          mensagem: 'Full não consultado (filtro atual é Galpão).',
          conta: null, porProdutoBase: [], pendentes: { skusNaoMapeados: [], semQuantidade: [], semSku: [] }, truncado: false,
        };

    const fullPorId = Object.fromEntries(full.porProdutoBase.map((p) => [p.produtoBaseId, p]));

    const itens = galpaoRows.map((row) => {
      const custo = row.custo === null ? null : Number(row.custo);
      const quantidadeGalpao = Number(row.quantidade_galpao);
      const fullInfo = fullPorId[row.produto_base_id];
      const quantidadeFull = precisaFull ? (full.consultado ? (fullInfo ? fullInfo.quantidadeFisica : 0) : null) : null;
      const quantidadeTotal = quantidadeFull === null ? null : quantidadeGalpao + quantidadeFull;

      return {
        produtoBaseId: row.produto_base_id,
        codigo: row.codigo,
        nome: row.nome,
        ativo: row.ativo,
        custo,
        quantidadeGalpao,
        quantidadeFull,
        quantidadeTotal,
        valorGalpao: custo === null ? null : round2(quantidadeGalpao * custo),
        valorFull: custo === null || quantidadeFull === null ? null : round2(quantidadeFull * custo),
        valorTotal: custo === null || quantidadeTotal === null ? null : round2(quantidadeTotal * custo),
      };
    });

    // Cards do topo: somam só o que o filtro pede. Se o Full for necessário
    // e não puder ser consultado agora, o total fica "pendente" em vez de
    // mostrar um número que ignoraria o Full silenciosamente.
    let resumo;
    if (filtro === 'galpao') {
      const semCusto = itens.filter((it) => it.custo === null && it.quantidadeGalpao > 0);
      resumo = {
        quantidadeTotalCaixas: itens.reduce((s, it) => s + it.quantidadeGalpao, 0),
        valorTotalEstoque: round2(itens.reduce((s, it) => s + (it.valorGalpao || 0), 0)),
        quantidadeSemCusto: semCusto.length,
        valorParcial: semCusto.length > 0,
        pendente: false,
      };
    } else if (filtro === 'full') {
      if (!full.consultado) {
        resumo = { quantidadeTotalCaixas: null, valorTotalEstoque: null, quantidadeSemCusto: 0, valorParcial: false, pendente: true };
      } else {
        const semCusto = itens.filter((it) => it.custo === null && (it.quantidadeFull || 0) > 0);
        resumo = {
          quantidadeTotalCaixas: itens.reduce((s, it) => s + (it.quantidadeFull || 0), 0),
          valorTotalEstoque: round2(itens.reduce((s, it) => s + (it.valorFull || 0), 0)),
          quantidadeSemCusto: semCusto.length,
          valorParcial: semCusto.length > 0,
          pendente: false,
        };
      }
    } else {
      if (!full.consultado) {
        resumo = { quantidadeTotalCaixas: null, valorTotalEstoque: null, quantidadeSemCusto: 0, valorParcial: false, pendente: true };
      } else {
        const semCusto = itens.filter((it) => it.custo === null && (it.quantidadeTotal || 0) > 0);
        resumo = {
          quantidadeTotalCaixas: itens.reduce((s, it) => s + (it.quantidadeTotal || 0), 0),
          valorTotalEstoque: round2(itens.reduce((s, it) => s + (it.valorTotal || 0), 0)),
          quantidadeSemCusto: semCusto.length,
          valorParcial: semCusto.length > 0,
          pendente: false,
        };
      }
    }

    res.json({
      filtro,
      full: {
        consultado: full.consultado,
        pendente: full.pendente,
        motivo: full.motivo,
        mensagem: full.mensagem,
        conta: full.conta,
        truncado: full.truncado,
      },
      itens,
      resumo,
      pendentes: precisaFull ? full.pendentes : { skusNaoMapeados: [], semQuantidade: [], semSku: [] },
    });
  } catch (err) { next(err); }
});

// PUT /api/estoque-produto-base/:produtoBaseId — ajuste manual do Galpão
// (mesmo padrão transacional de routes/estoque.js: BEGIN + SELECT FOR UPDATE
// + upsert + histórico de movimentação + COMMIT). Nunca mexe no Full — Full
// é sempre um espelho ao vivo da API do Mercado Livre, não é editável aqui.
router.put('/:produtoBaseId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const produtoBaseId = req.params.produtoBaseId;
    const { empresaId } = req.body;
    const novaQuantidade = Number(req.body.quantidade);
    const observacao = req.body.observacao ? String(req.body.observacao).trim().slice(0, 500) : null;

    if (!empresaId) {
      return res.status(400).json({ error: 'Informe empresaId.' });
    }
    if (!Number.isInteger(novaQuantidade) || novaQuantidade < 0) {
      return res.status(400).json({ errors: { quantidade: 'Informe uma quantidade inteira, maior ou igual a zero.' } });
    }

    await client.query('BEGIN');

    const { rows: pbRows } = await client.query(
      'SELECT * FROM produtos_base WHERE id = $1 AND empresa_id = $2',
      [produtoBaseId, empresaId]
    );
    if (!pbRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto base não encontrado.' });
    }
    const produtoBase = pbRows[0];

    const { rows: estoqueRows } = await client.query(
      'SELECT * FROM estoque_produto_base WHERE produto_base_id = $1 FOR UPDATE',
      [produtoBaseId]
    );
    let estoque = estoqueRows[0];
    const quantidadeAnterior = estoque ? estoque.quantidade : 0;

    if (estoque) {
      const { rows } = await client.query(
        'UPDATE estoque_produto_base SET quantidade = $1, atualizado_em = now() WHERE id = $2 RETURNING *',
        [novaQuantidade, estoque.id]
      );
      estoque = rows[0];
    } else {
      const { rows } = await client.query(
        'INSERT INTO estoque_produto_base (produto_base_id, quantidade) VALUES ($1,$2) RETURNING *',
        [produtoBaseId, novaQuantidade]
      );
      estoque = rows[0];
    }

    await client.query(
      `INSERT INTO estoque_produto_base_movimentos (estoque_produto_base_id, quantidade_anterior, quantidade_nova, diferenca, observacao)
       VALUES ($1, $2, $3, $4, $5)`,
      [estoque.id, quantidadeAnterior, novaQuantidade, novaQuantidade - quantidadeAnterior, observacao]
    );

    await client.query('COMMIT');

    const custo = produtoBase.custo === null ? null : Number(produtoBase.custo);
    res.json({
      item: {
        produtoBaseId: produtoBase.id,
        codigo: produtoBase.codigo,
        nome: produtoBase.nome,
        custo,
        quantidadeGalpao: estoque.quantidade,
        valorGalpao: custo === null ? null : round2(estoque.quantidade * custo),
        atualizadoEm: estoque.atualizado_em,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
