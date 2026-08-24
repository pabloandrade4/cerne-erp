// Interpretação (heurística) de um SKU de venda para SUGERIR um produto
// base e um multiplicador — nunca a fonte de verdade. Pensado para o
// padrão descrito pelo usuário: dígitos no início do SKU = multiplicador,
// resto do texto = código do produto base.
//   '100CX-19X12X12' -> { multiplicador: 100, codigoBase: 'CX-19X12X12' }
//   '25CX-19X12X12'  -> { multiplicador: 25,  codigoBase: 'CX-19X12X12' }
// Se o SKU não começar com dígitos (ou não sobrar nada depois deles), a
// função devolve null — nesse caso o vínculo só pode ser criado
// manualmente, nunca inventado. O vínculo salvo em `produto_base_skus` é
// sempre o que vale; isto aqui só preenche um formulário de sugestão.
function interpretarSku(skuOriginal) {
  const sku = String(skuOriginal || '').trim();
  if (!sku) return null;

  const match = /^(\d+)[-_\s]*(.+)$/.exec(sku);
  if (!match) return null;

  const multiplicador = Number(match[1]);
  const codigoBase = match[2].trim();
  if (!Number.isInteger(multiplicador) || multiplicador <= 0 || !codigoBase) return null;

  return { sku, multiplicador, codigoBase };
}

module.exports = { interpretarSku };
