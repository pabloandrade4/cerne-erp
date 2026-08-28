// Base de conhecimento da IA Gestora — consulta de REGRAS DE NEGÓCIO e
// LIMITAÇÕES conhecidas do ERP, pedida explicitamente na tarefa "IA Gestora
// como inteligência central" ("consultar documentação interna do ERP para
// regras de negócio" — ver docs/02-decisoes.md).
//
// Por que um módulo curado em vez de ler docs/*.md direto: a pasta docs/
// não é enviada no pacote de deploy (é documentação interna do
// desenvolvimento, não um artefato do servidor em produção) — então não
// existe um arquivo em disco pra ler em produção. Em vez de mudar o
// processo de deploy só pra isso, este arquivo extrai, em texto curto e já
// pronto pra IA citar, exatamente as regras que já estão documentadas em
// docs/00-visao-geral.md e docs/01-regras-de-negocio.md — nenhuma regra
// nova é inventada aqui, cada entrada é um resumo fiel do que já está
// registrado (e deve ser atualizado junto sempre que a regra de origem
// mudar — mesma disciplina do resto da documentação).
const TEMAS = {
  regra_geral_nunca_inventar: {
    titulo: 'Regra central: nunca inventar valor',
    texto: 'O ERP nunca inventa, estima ou arredonda um valor financeiro que falte. Quando falta uma informação (custo de SKU não cadastrado, tarifa que a API do marketplace não retornou, saldo bancário nunca cadastrado), o campo correspondente fica "Pendente"/indisponível, nunca um número calculado com uma parte presumida. Essa regra vale em todas as telas do sistema, sem exceção, inclusive nas respostas da própria IA Gestora.',
  },
  ads: {
    titulo: 'Ads (Mercado Ads / Product Ads)',
    texto: 'A API de publicidade do Mercado Livre não identifica quais pedidos específicos vieram de um anúncio patrocinado — ela só devolve totais agregados atribuídos por anúncio/dia (investimento, vendas atribuídas). Por isso o ERP mostra duas visões sempre separadas, nunca misturadas numa única conta: "Performance atribuída Mercado Ads" (investimento, vendas atribuídas, ROAS, ACOS — direto da API de Ads) e "Resultado real do SKU após Ads" (a margem de contribuição REAL das vendas daquele anúncio, calculada pela mesma fórmula de sempre, menos o investimento em Ads). A segunda visão pode incluir venda orgânica (não gerada pelo Ads) misturada com a paga — o ERP nunca afirma que 100% daquela venda veio do anúncio. Por isso os números de ROAS/ACOS do ERP podem não bater exatamente com o painel oficial do Mercado Ads (que usa uma metodologia de atribuição própria, não pública).',
  },
  estoque: {
    titulo: 'Estoque e Estoque Full',
    texto: 'Desde 26/08/2026 o estoque é sempre um espelho de somente leitura do que o Mercado Livre retorna — o ERP não aceita mais ajuste manual e não decide saldo por conta própria. As telas Estoque (fora do Full) e Estoque Full são sempre separadas, nunca somadas. O estoque é organizado por anúncio/variação (SKU do Mercado Livre) — NÃO existe hoje um agrupamento de estoque "por caixa"/produto físico (esse agrupamento existe só no Relatório de Produtos, categoria "Por Caixa", que é uma visão financeira de vendas, não de estoque). Uma venda nunca dá baixa de estoque no ERP — o saldo mostrado sempre vem direto do Mercado Livre.',
  },
  fluxo_de_caixa: {
    titulo: 'Fluxo de caixa e saldo bancário',
    texto: 'O ERP ainda não tem nenhum cadastro de saldo bancário real. Por isso um "saldo projetado" (saldo atual + recebimentos previstos − contas a pagar − outras saídas previstas) nunca pode ser calculado com segurança — sem um saldo inicial de verdade, esse número seria inventado. O que o ERP mostra são os componentes reais dessa conta, separados: contas a receber em aberto, contas a pagar em aberto, e recebimentos do Mercado Livre esperados no período — sempre deixando claro que é uma projeção (PREVISTO), nunca dinheiro já disponível (REALIZADO). Perguntas hipotéticas ("se eu gastar X, como fica meu caixa?") podem ser respondidas qualitativamente com esses números reais, mas nunca com um saldo final inventado.',
  },
  compras_fornecedores: {
    titulo: 'Compras e Fornecedores',
    texto: 'Compras é um cadastro simples de pedido de compra a um fornecedor (criar, listar, editar, mudar status: Em aberto, Pedido realizado, Recebido, Cancelado). Marcar uma compra como "Recebido" NÃO dá entrada automática no Estoque — essa automação não existe ainda (pedido explícito do usuário, fica para uma etapa futura). Não existe nenhuma IA de sugestão de reposição ou previsão de demanda de compras nesta etapa.',
  },
  notas_fiscais: {
    titulo: 'Emissão de notas fiscais',
    texto: 'A tela de notas fiscais é só um REGISTRO manual dos dados de uma nota (número, série, data de emissão, chave de acesso) — não existe integração real com a SEFAZ, nenhuma nota é de fato transmitida/autorizada perante o fisco pelo ERP. Uma nota só pode ser marcada como "Emitida" se todos esses campos forem informados — o sistema nunca inventa número de NF-e nem chave de acesso.',
  },
  contas_a_pagar_receber: {
    titulo: 'Contas a Pagar e Contas a Receber',
    texto: '"Vencido"/"Atrasado" nunca é um status gravado no banco — é sempre calculado na hora (pendente/a_receber com data no passado), pra nunca depender de um processo em segundo plano. Um lançamento já pago/recebido ou cancelado não pode mais ser editado nem excluído (fica como registro histórico — se foi lançado errado, o certo é cancelar e lançar de novo, não editar o que já virou fato financeiro).',
  },
  dre: {
    titulo: 'DRE (Demonstrativo de Resultado)',
    texto: 'A DRE não usa nenhuma fórmula financeira nova — reorganiza, em formato de demonstrativo, os mesmos números já usados em Visão Geral/Pedidos/Financeiro (vendas) mais o que já é mostrado em Contas a Pagar (despesas pagas no período). A Margem de Contribuição da DRE é sempre lida direto da mesma fonte de sempre (nunca recalculada por subtração das linhas do demonstrativo) — em casos raros de pendência parcial, a soma das linhas pode não bater centavo a centavo com ela; quando isso acontece, o valor da Margem de Contribuição é sempre o correto. "Resultado Final" só é calculado quando a Margem de Contribuição em si é conhecida (não pendente).',
  },
  produtos_por_caixa: {
    titulo: 'Relatório de Produtos — visão "Por Caixa"',
    texto: 'Agrupa os SKUs/kits do Mercado Livre que representam a mesma medida/produto físico (ex: uma caixa 20x20x20), somando as caixas físicas vendidas. A identificação do produto físico por trás de um SKU segue uma ordem fixa: 1) um vínculo salvo manualmente (sempre vence, pode ter sido corrigido por um humano); 2) sem vínculo salvo, o padrão do próprio texto do SKU é interpretado (dígitos no início = unidades por kit, resto = código do produto — isso é leitura determinística de um identificador, não uma estimativa); 3) SKU que não segue nenhum padrão nunca é chutado — aparece à parte, em "sem produto base identificado", fora do agrupamento e do total de caixas.',
  },
  ia_gestora: {
    titulo: 'O que a IA Gestora pode e não pode fazer',
    texto: 'A IA Gestora, nesta versão, é só de CONSULTA E ANÁLISE. Ela pode: consultar, analisar, comparar, calcular (usando as mesmas contas que já existem no ERP), projetar (com os dados reais disponíveis), criar relatórios, explicar e recomendar. Ela NÃO PODE: pagar conta, alterar custo, alterar imposto, alterar estoque, criar compra, alterar anúncio, alterar preço, cancelar pedido, emitir nota fiscal nem modificar qualquer informação do ERP. Se pedirem uma dessas ações, ela explica que ainda não faz isso e indica a tela certa para a ação manual.',
  },
  shopee: {
    titulo: 'Shopee',
    texto: 'Desde 25/08/2026 o ERP já conecta de verdade uma loja da Shopee por empresa (autorização, token, renovação automática — ver Marketplaces). Esta etapa é só a CONEXÃO: pedidos, estoque, Ads e financeiro da Shopee ainda NÃO são importados nem calculados — nenhuma ferramenta desta IA traz dado de venda/estoque/Ads da Shopee ainda (só do Mercado Livre). Se perguntarem sobre vendas/estoque/Ads da Shopee, responda com honestidade: a loja pode estar conectada, mas os dados de venda dela ainda não chegam ao ERP.',
  },
  permissoes_usuario: {
    titulo: 'Permissões de usuário e login',
    texto: 'Desde 25/08/2026 a IA Gestora exige login real (e-mail/senha, sessão) para conversar e ver o histórico — ver lib/auth/. Um usuário logado nunca vê o histórico de conversas de outro. O que continua igual ao resto do ERP: uma empresa não pertence a um usuário específico — qualquer login válido pode selecionar qualquer empresa ativa no cabeçalho (não existe, em nenhuma tela do sistema, uma permissão de "quais empresas este usuário pode ver").',
  },
};

function consultarDocumentacao(tema) {
  const entrada = TEMAS[tema];
  if (!entrada) {
    return {
      encontrado: false,
      temasDisponiveis: Object.keys(TEMAS),
      observacao: 'Tema não encontrado na documentação interna — escolha um dos temasDisponiveis.',
    };
  }
  return { encontrado: true, tema, titulo: entrada.titulo, texto: entrada.texto };
}

module.exports = { TEMAS, consultarDocumentacao };
