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
    texto: 'Desde 26/08/2026 o estoque é sempre um espelho de somente leitura do que o Mercado Livre retorna — o ERP não aceita mais ajuste manual e não decide saldo por conta própria. As telas Estoque (fora do Full) e Estoque Full são sempre separadas, nunca somadas. Desde 26/08/2026 (2ª correção) a IA Gestora também sabe converter anúncio/kit em produto FÍSICO (ex: 1 unidade do anúncio "100CX-20X20X20" = 100 caixas físicas), usando a mesma regra normalizada do Relatório de Produtos > "Por Caixa" — por isso ela consegue responder "quanto tenho no Full em matéria-prima/quanto vale a custo", "quantas caixas físicas tenho no Full" e "quais produtos representam mais dinheiro no Full", separando sempre o valor do estoque Full do valor do estoque fora do Full (ferramentas estoque_valor_parado e estoque_fisico_detalhado). O que o ERP ainda NÃO consegue: consultar o estoque "em trânsito/aguardando conferência" (produtos já enviados ao Full mas ainda não disponíveis) — só o Full já disponível/recebido. Uma venda nunca dá baixa de estoque no ERP — o saldo mostrado sempre vem direto do Mercado Livre.',
  },
  fluxo_de_caixa: {
    titulo: 'Fluxo de caixa e saldo bancário',
    texto: 'Existem DUAS ferramentas de fluxo de caixa, de propósito diferente — nunca misture os números das duas numa mesma resposta. "fluxo_de_caixa" (o card simples de Visão Geral) nunca teve saldo bancário e nunca terá um "saldo projetado" — mostra só os componentes soltos (contas a receber/pagar em aberto, recebimentos ML esperados). "fluxo_de_caixa_detalhado" (a tela dedicada Fluxo de Caixa, desde 25/08/2026, ampliada em 27/08/2026 com extrato bancário e conciliação) TEM saldo real quando — e só quando — o usuário já informou um saldo bancário inicial na tela (nunca antes disso: sem saldo inicial informado, "saldoAtual"/"saldoProjetado" vêm null com o motivo, nunca um número inventado). Desde 27/08/2026 o usuário também pode importar o extrato bancário semanalmente (XLSX/CSV) e conciliar movimentações com recebimentos de marketplace/Contas a Receber/Contas a Pagar — só como SUGESTÃO que o próprio usuário confirma, nunca automático. Quando conciliado, o valor que estava "previsto" passa a contar como "realizado" e some do "previsto" — nunca soma os dois. Sempre diferencie REALIZADO (já aconteceu, conferido no banco) de PREVISTO/PROJETADO (expectativa) na resposta.',
  },
  recebimentos_marketplace: {
    titulo: 'Recebimentos de marketplace — status financeiro',
    texto: 'Desde 27/08/2026 cada recebimento de marketplace (Mercado Livre) tem um status financeiro persistido, sempre um dos três, nunca confundidos: A_RECEBER (venda já realizada, dinheiro ainda não disponível), DISPONÍVEL (o marketplace já marcou como liberado — mas isso ainda NÃO significa confirmado no banco), RECEBIDO/CONCILIADO (valor efetivamente identificado no extrato bancário importado, via conciliação, ou confirmado manualmente pelo usuário). Nunca chame algo de "recebido no banco" só porque o marketplace marcou como disponível/liberado. O Mercado Livre não retorna, nos dados que o ERP já sincroniza, nenhuma data real de liberação/repasse — por isso "data prevista de liberação" só existe quando o próprio usuário a informa manualmente na tela Recebimentos; sem isso, aquele recebimento aparece separado em "sem previsão de liberação informada", nunca estimado ou escondido dentro de um recorte de dias (7/15/30).',
  },
  extrato_bancario_conciliacao: {
    titulo: 'Importação de extrato bancário e conciliação',
    texto: 'Desde 27/08/2026 o usuário pode importar o extrato bancário (XLSX/CSV, tipicamente semanal) em Fluxo de Caixa > Importar extrato bancário. Cada movimentação recebe um hash determinístico (conta bancária + data + valor + tipo + descrição + documento) e o próprio banco garante que a mesma planilha importada duas vezes NUNCA duplica movimentações. A conciliação (relacionar uma movimentação do extrato com um recebimento de marketplace/Contas a Receber/Contas a Pagar) é sempre uma SUGESTÃO ("possível conciliação encontrada", por valor batendo e proximidade de data) que o usuário CONFIRMA manualmente — nunca automática. A planilha original nunca é armazenada, só as movimentações já estruturadas.',
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
    texto: 'A IA Gestora, nesta versão, é só de CONSULTA E ANÁLISE. Ela pode: consultar, analisar, comparar, calcular (usando as mesmas contas que já existem no ERP), projetar (com os dados reais disponíveis), criar relatórios, explicar e recomendar. Ela NÃO PODE: pagar conta, alterar custo, alterar imposto, alterar estoque, criar compra, alterar anúncio, alterar preço, cancelar pedido, emitir nota fiscal nem modificar qualquer informação do ERP — isso inclui, desde 27/08/2026: excluir uma movimentação do extrato bancário, marcar um recebimento/conta como recebido/pago, ou conciliar uma movimentação (mesmo quando a sugestão de conciliação for óbvia) — todas as ferramentas de Recebimentos/Fluxo de Caixa/extrato bancário da IA são SOMENTE LEITURA; essas ações continuam sempre manuais, confirmadas pelo próprio usuário nas telas. Se pedirem uma dessas ações, ela explica que ainda não faz isso e indica a tela certa para a ação manual.',
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
