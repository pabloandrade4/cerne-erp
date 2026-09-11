// Rota ADMINISTRATIVA TEMPORÁRIA — usada uma única vez para migrar todos os
// dados do banco atual (DATABASE_URL) para o Supabase (SUPABASE_DATABASE_URL),
// preservando os IDs de cada linha (necessário porque outras tabelas
// referenciam esses IDs por chave estrangeira). Depois de usada e confirmada,
// este arquivo é removido do projeto — não faz parte do funcionamento normal
// do ERP.
//
// Protegida por um token (ADMIN_MIGRATION_TOKEN, configurado só no servidor,
// nunca no front-end) enviado no header "x-admin-token". Sem o token certo,
// a rota responde 403 e não faz nada.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const router = express.Router();

function poolFor(connectionString) {
  const isLocal = !connectionString || /localhost|127\.0\.0\.1/.test(connectionString);
  return new Pool({ connectionString, ssl: isLocal ? false : { rejectUnauthorized: false } });
}

// Ordem pensada para respeitar as chaves estrangeiras (tabela referenciada
// antes de quem referencia ela).
const TABELAS = [
  ['empresas', ['id', 'cnpj', 'razao_social', 'nome_fantasia', 'ativo', 'created_at', 'updated_at']],
  ['users', ['id', 'email', 'password_hash', 'name', 'created_at']],
  ['ml_contas', ['id', 'empresa_id', 'ml_user_id', 'nickname', 'email', 'site_id', 'access_token_enc', 'refresh_token_enc', 'token_expires_at', 'status', 'ultimo_erro', 'ultima_sincronizacao_em', 'created_at', 'updated_at']],
  ['custos_produto', ['id', 'empresa_id', 'sku', 'custo', 'criado_em', 'atualizado_em']],
  ['config_financeiro', ['empresa_id', 'aliquota_imposto', 'atualizado_em']],
  ['produtos', ['id', 'empresa_id', 'nome', 'sku', 'custo', 'ativo', 'created_at', 'updated_at']],
  ['fornecedores', ['id', 'empresa_id', 'razao_social', 'nome_fantasia', 'documento', 'telefone', 'email', 'observacao', 'ativo', 'created_at', 'updated_at']],
  ['estoque', ['id', 'produto_id', 'quantidade', 'atualizado_em']],
  ['estoque_movimentos', ['id', 'estoque_id', 'tipo', 'quantidade_anterior', 'quantidade_nova', 'diferenca', 'observacao', 'criado_em']],
  ['compras', ['id', 'empresa_id', 'fornecedor_id', 'data_compra', 'previsao_chegada', 'status', 'valor_total', 'observacao', 'created_at', 'updated_at']],
  ['compra_itens', ['id', 'compra_id', 'produto_id', 'quantidade', 'custo_unitario', 'valor_total_item']],
  ['ml_pedidos', ['id', 'conta_ml_id', 'ml_order_id', 'pack_id', 'data_criacao', 'data_fechamento', 'status', 'status_detail', 'comprador_id', 'comprador_nickname', 'valor_total', 'moeda', 'ml_payment_id', 'pagamento_status', 'pagamento_taxas', 'pagamento_taxa_marketplace', 'pagamento_metodo', 'ml_shipping_id', 'envio_status', 'envio_logistic_mode', 'envio_logistic_type', 'frete_comprador', 'frete_vendedor', 'taxa_venda_total', 'raw_pedido', 'raw_envio', 'raw_custos_envio', 'criado_em', 'atualizado_em']],
  ['ml_pedido_itens', ['id', 'pedido_id', 'ml_item_id', 'titulo', 'sku', 'variation_id', 'quantidade', 'preco_unitario', 'preco_unitario_original', 'valor_total_item', 'taxa_venda']],
  ['ml_pedido_pagamentos', ['id', 'pedido_id', 'ml_payment_id', 'status', 'status_detail', 'payment_type', 'payment_method_id', 'transaction_amount', 'taxes_amount', 'shipping_cost', 'marketplace_fee', 'installments', 'date_approved', 'date_created', 'raw_pagamento']],
];
// ml_oauth_states (transitório, uso único no fluxo OAuth) e ml_sync_historicos
// (tabela nova, sem dado antigo pra trazer) não entram na migração de propósito.

// Linhas por lote de INSERT — copiar linha por linha (1 round-trip de rede
// por linha) ficou lento demais indo até o Supabase (banco de origem e
// destino em provedores/regiões diferentes): uma conta com ~2.370 pedidos já
// passa de 8 mil linhas somando pedidos+itens+pagamentos. Em lotes de 300
// linhas por INSERT, o mesmo total vira só algumas dezenas de round-trips.
const TAMANHO_LOTE = 300;

function normalizarValor(v) {
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

async function copiarTabela(source, target, tabela, colunas) {
  const ordenarPor = colunas.includes('id') ? 'id' : colunas[0];
  const { rows } = await source.query(`SELECT ${colunas.join(',')} FROM ${tabela} ORDER BY ${ordenarPor}`);
  let copiadas = 0;

  for (let inicio = 0; inicio < rows.length; inicio += TAMANHO_LOTE) {
    const lote = rows.slice(inicio, inicio + TAMANHO_LOTE);
    const values = [];
    const gruposDePlaceholder = lote.map((row, i) => {
      const placeholders = colunas.map((_, j) => {
        values.push(normalizarValor(row[colunas[j]]));
        return `$${i * colunas.length + j + 1}`;
      });
      return `(${placeholders.join(',')})`;
    });

    const r = await target.query(
      `INSERT INTO ${tabela} (${colunas.join(',')}) VALUES ${gruposDePlaceholder.join(',')} ON CONFLICT DO NOTHING`,
      values
    );
    copiadas += r.rowCount;
  }

  if (colunas.includes('id')) {
    await target.query(
      `SELECT setval(pg_get_serial_sequence('${tabela}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${tabela}), 1), 1), true)`
    );
  }
  return { encontradas: rows.length, copiadas };
}

// POST /api/admin/migrar-para-supabase — copia tudo de DATABASE_URL (banco
// atual) para SUPABASE_DATABASE_URL (banco novo), preservando IDs. Idempotente
// o bastante para rodar de novo sem duplicar (ON CONFLICT DO NOTHING) — mas
// pensada para ser usada uma única vez.
router.post('/migrar-para-supabase', async (req, res) => {
  const token = req.header('x-admin-token');
  if (!process.env.ADMIN_MIGRATION_TOKEN || token !== process.env.ADMIN_MIGRATION_TOKEN) {
    return res.status(403).json({ error: 'Token inválido.' });
  }
  if (!process.env.SUPABASE_DATABASE_URL) {
    return res.status(400).json({ error: 'SUPABASE_DATABASE_URL não configurada no servidor.' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(400).json({ error: 'DATABASE_URL (banco de origem) não configurada no servidor.' });
  }

  const source = poolFor(process.env.DATABASE_URL);
  const target = poolFor(process.env.SUPABASE_DATABASE_URL);

  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await target.query(schemaSql);

    const resultado = {};
    for (const [tabela, colunas] of TABELAS) {
      resultado[tabela] = await copiarTabela(source, target, tabela, colunas);
    }

    res.json({ ok: true, copiado: resultado });
  } catch (err) {
    console.error('[migrar-para-supabase]', err);
    res.status(500).json({ error: err.message });
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
});

module.exports = router;
