# Próximos Passos

- **Concluído em 25/08/2026, testado localmente (Postgres real + servidor
  real via HTTP, com os multiplicadores 25/50/75/100/200 pedidos pelo
  usuário — 8 testes automatizados novos, 160 no total no projeto, 28
  suítes, 0 falhas):** Relatórios → Produtos ganhou a visão "Por Caixa" —
  ver `04-alteracoes.md` e `02-decisoes.md` (24). Candidatos a próximo
  passo, **nenhum pedido ainda**:
  1. Uma tela de gestão dos vínculos SKU → produto base (cadastrar/
     corrigir manualmente quando o padrão automático do SKU erra ou não
     se aplica) — a API já existe (`routes/produtosBase.js`), só falta
     interface no menu (ver `05-problemas-conhecidos.md`).
  2. Estender a exportação (XLSX/CSV) pra visão Por Caixa — hoje só existe
     para Por SKU.
  3. Considerar reaproveitar a mesma visão "Por Caixa" (produto base +
     multiplicador) em outras telas que hoje mostram só SKU, se fizer
     sentido pro usuário (ex: Estoque, se ele voltar a precisar dessa
     visão agrupada).
- **Candidato a correção futura, NÃO feito agora (escopo explicitamente
  limitado a Contas a Pagar em 25/08/2026 — ver `04-alteracoes.md` e
  `02-decisoes.md` (23)):** o mesmo bug corrigido em Contas a Pagar
  (lista escondendo registros com data futura por causa do filtro de
  período do header, e `new Date().toISOString().slice(0,10)` calculando
  "hoje" em UTC em vez de America/Sao_Paulo) muito provavelmente também
  afeta **Contas a Receber** (`lib/contasReceber.js`/`listarContasReceber`
  tem a mesma estrutura, filtrando por `dataPrevista` dentro do período) e
  o campo "Data da compra" de **Compras** (mesmo cálculo de "hoje" em
  UTC). Vale confirmar e corrigir do mesmo jeito quando o usuário pedir.
- **Concluído em 28/08/2026, testado localmente (Postgres real + servidor
  real via HTTP — rota `POST /api/ia-gestora/perguntar` testada de ponta
  a ponta contra o Postgres de teste; laço de ferramentas testado com um
  provedor de IA FALSO — 26 testes automatizados novos, 149 no total no
  projeto, 27 suítes, 0 falhas):** ativação da IA Gestora — chat de
  consulta e análise conectado a dados reais — ver `04-alteracoes.md`
  (22) e `02-decisoes.md` (22). Falta, **nesta ordem**:
  1. o usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto);
  2. **configurar `IA_API_KEY` no Render** (Settings → Environment do
     serviço `cerne-erp`) com uma chave de API válida da Anthropic
     (https://console.anthropic.com) — sem isso, a tela abre normalmente
     mas avisa que a IA ainda não está configurada;
  3. depois do deploy e da chave configurada, testar a IA Gestora ao vivo
     com perguntas reais (as 12 do pedido original + as 5 sugeridas na
     tela), com a conta/empresa real conectada;
  4. comparar pelo menos 3-4 respostas da IA com o que Visão Geral/
     Pedidos/Financeiro/DRE mostram pro mesmo período, número a número
     (ex: perguntar "quanto vendi este mês" e conferir contra o
     faturamento mostrado em Visão Geral) — confirmando que não existe
     divergência entre a IA e o resto do ERP;
  5. confirmar que a IA nunca inventa dado: perguntar algo que dependa de
     custo não cadastrado (ex: margem de um SKU sem custo) e conferir que
     ela explica a pendência em vez de estimar um número;
  6. testar a troca de empresa e de período no header durante uma
     conversa, confirmando que a conversa reinicia e a resposta seguinte
     reflete a nova seleção;
  7. se o identificador de modelo padrão (`claude-sonnet-4-5-20250929`)
     não funcionar (ver `05-problemas-conhecidos.md`), conferir o
     identificador atual em https://docs.claude.com e ajustar `IA_MODELO`
     no Render — sem precisar de nenhum novo deploy de código;
  - **por instrução explícita do usuário, esta etapa parou nestes 3
    passos** — não avançar sozinho para a IA poder alterar dados (custo,
    estoque, compras, contas, notas fiscais, anúncios, pedidos), nem para
    nenhuma outra área, sem o usuário pedir depois de validar que ela
    entende corretamente os dados da empresa.
- **Concluído em 26/08/2026, testado localmente (Postgres real + servidor
  real via HTTP + navegador real via Playwright, trocando empresa e
  período de verdade — 13 testes automatizados novos, 123 no total, 0
  falhas):** ativação da parte inferior da Visão Geral — Evolução diária +
  Por marketplace, Fluxo de Caixa + Conexões & Empresas, Alertas & IA —
  ver `04-alteracoes.md` (21) e `02-decisoes.md` (21). Falta, **nesta
  ordem**:
  1. o usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto);
  2. depois do deploy, confirmar ao vivo em produção que os 5 blocos
     aparecem com dado real da conta "PFEMBALAGEMS" (ou outra conta real
     conectada) e que trocar empresa/período no header atualiza todos
     juntos, igual ao testado aqui;
  3. clicar em pelo menos 1 alerta real de cada tipo que aparecer, para
     confirmar que a navegação leva pra tela certa (testado aqui só com
     alertas fabricados/uma empresa de teste, nunca com o alerta
     aparecendo organicamente em produção);
  4. quando o usuário cadastrar custo nos SKUs pendentes (mesma pendência
     já registrada pra DRE/Relatórios/Ads), conferir que os alertas "SKU
     sem custo"/"pedido sem custo" desaparecem sozinhos;
  - **por instrução explícita do usuário, esta etapa parou nestes 3
    passos** — não avançar sozinho para Shopee de verdade, cadastro de
    saldo bancário (pré-requisito de "saldo projetado"), ou uma IA/modelo
    preditivo nos alertas, sem o usuário pedir (ver
    `05-problemas-conhecidos.md` para o que fica registrado sobre esses
    dois primeiros pontos).
- **Concluído em 26/08/2026, testado localmente (Postgres real + servidor
  real via HTTP + Mercado Livre mockado, 29 testes automatizados novos —
  110 no total, 0 falhas):** reescrita do módulo Estoque para usar o
  Mercado Livre como fonte oficial das quantidades, quantidade somente
  leitura (ajuste manual removido), Estoque e Estoque Full separados em
  duas telas — ver `04-alteracoes.md` (20) e `02-decisoes.md` (20). Falta,
  **nesta ordem**:
  1. o usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto);
  2. depois do deploy, testar ao vivo em produção o cenário exato pedido
     pelo usuário: mudar a quantidade de um anúncio no Mercado Livre (por
     exemplo, de 500 para 800), esperar o ciclo automático de 1 minuto (ou
     clicar em "Sincronizar agora") e confirmar que o valor novo aparece
     corretamente na tela Estoque do ERP, sem duplicar linha e sem misturar
     com o Full;
  3. conferir que a separação Estoque / Estoque Full está correta com dado
     real — a mesma conta/anúncio não pode aparecer com quantidades
     diferentes nas duas telas por engano, e a soma de uma tela nunca deve
     aparecer somada com a outra;
  4. se a conta conectada usar estoque multi-origem (User Products),
     validar que o caminho `user_product_id` está retornando o valor certo
     — ver `05-problemas-conhecidos.md`, o formato exato da resposta dessa
     API não foi confirmado contra uma chamada real; se a conta de teste
     "PFEMBALAGEMS" não usar esse modelo, esse caminho específico continua
     sem validação real até haver uma conta assim disponível;
  5. confirmar que o botão de ajuste manual de estoque (Galpão) realmente
     sumiu/está desativado em produção, e que nenhuma tela antiga ficou
     acessível por link direto;
  - **por instrução explícita do usuário, esta etapa parou nestes 3
    ajustes** — não avançar sozinho para alertas de estoque baixo,
    previsão de reposição, ou qualquer outra funcionalidade sem o usuário
    pedir.
- **Concluído em 24/08/2026, testado localmente (Postgres real + servidor
  real via HTTP, 8 testes automatizados novos — 80 no total, 0 falhas):**
  sincronização automática do Mercado Livre a cada 1 minuto, no backend —
  ver `04-alteracoes.md` (19) e `02-decisoes.md` (19). Falta, **nesta
  ordem**:
  1. **O usuário faz o upgrade do serviço `cerne-erp` no Render, de Free
     para Starter** (painel do Render → Settings → Instance Type) — sem
     isso, o ciclo de 1 minuto não roda de forma confiável 24h (ver
     `05-problemas-conhecidos.md`). Essa etapa é do usuário, não existe
     ferramenta disponível nesta sessão para trocar o plano de um serviço
     já existente.
  2. o usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto);
  3. depois do deploy (e do upgrade de plano), confirmar em produção,
     nesta ordem — igual ao checklist pedido pelo usuário:
     - testar criando/aguardando um pedido novo na conta real conectada;
     - confirmar que ele aparece no ERP automaticamente, sem clicar em
       "Sincronizar" (o indicador do header deve mostrar "Sincronizado há
       Xs" mudando a cada minuto);
     - testar a sincronização repetida (esperar alguns minutos, deixar o
       ciclo rodar de novo) e confirmar que não cria pedido duplicado;
     - conferir os logs do Render: a linha `[sync automático] iniciado...`
       aparece uma vez no boot, e o serviço não reinicia sozinho por
       inatividade (sinal de que o Starter está mantendo o processo vivo);
     - se o webhook do Mercado Livre ainda não foi configurado no painel
       de desenvolvedor (ver pendência mais abaixo), considerar configurar
       agora — o ciclo de 1 minuto cobre o essencial, mas o webhook cobre
       pedidos com mais de 2 dias também (ver `05-problemas-conhecidos.md`).
  - **por instrução explícita do usuário, esta etapa parou nestes 3
    passos** — não avançar sozinho para otimizar a velocidade da
    sincronização em si, mudar a janela de reconciliação, ou qualquer
    outro módulo sem o usuário pedir.
- **Concluído em 25/08/2026, testado localmente (servidor real + Postgres
  local + navegador via Playwright, com os pedidos reais da conta
  PFEMBALAGEMS, 12 testes automatizados novos — 72 no total, 0 falhas):**
  ativação de Ads e Relatórios — ver `04-alteracoes.md` (18) e
  `02-decisoes.md` (17). Falta:
  - o usuário subir o próximo zip de código pro GitHub (deploy automático
    no Render cuida do resto);
  - depois do deploy, testar as duas telas ao vivo em produção: Ads com
    a conta real "PFEMBALAGEMS" (conferir se investimento/ROAS/ACOS
    aparecem com dado real ou se continuam "Pendente de sincronização" —
    ver `05-problemas-conhecidos.md`, a API de Advertising nunca foi
    testada contra uma conta real), Relatórios nas 3 categorias com
    filtro de empresa/loja/período/SKU e exportação (baixar o XLSX e o
    CSV de cada categoria, abrir e conferir que os totais batem com
    Visão Geral/Pedidos/Financeiro do mesmo período);
  - cadastrar custo nos SKUs que ainda estão sem, em Produtos, pra
    "Custo dos Produtos"/"Margem de Contribuição" pararem de aparecer
    como "pendente" em Ads e Relatórios (mesma pendência já registrada
    para a DRE);
  - se a conta de teste não tiver acesso a Product Ads, confirmar com o
    usuário se vale a pena habilitar (painel de desenvolvedor do
    Mercado Livre) pra validar o caminho de sucesso da API de Ads, hoje
    só validado pelo caminho de erro;
  - **por instrução explícita do usuário, esta etapa parou aqui** — não
    avançar sozinho para Shopee Ads, exportação em PDF, relatórios
    agendados ou qualquer outra área sem o usuário pedir.
- **Concluído em 24/08/2026, testado localmente (servidor real + Postgres
  local + navegador via Playwright, com os 11 pedidos reais da conta
  PFEMBALAGEMS):** ativação de DRE, Faturamento e Notas Fiscais — ver
  `04-alteracoes.md` (17) e `02-decisoes.md` (16). Falta:
  - o usuário subir o próximo zip de código pro GitHub (deploy automático
    no Render cuida do resto);
  - depois do deploy, testar as três telas ao vivo em produção: DRE com
    mais de uma empresa/período (inclusive um período sem nenhum pedido,
    pra confirmar o "Sem dados"), Faturamento marcando situação
    individual e em lote, Notas Fiscais preenchendo e emitindo uma nota
    completa (número/série/data/chave de 44 dígitos) e conferindo que
    aparece corretamente vinculada ao pedido certo;
  - conferir que o filtro de empresa/período do header funciona nas três
    telas com dado real de mais de uma empresa;
  - cadastrar custo nos SKUs que ainda estão sem, em Produtos, pra "Custo
    dos Produtos"/"Margem de Contribuição" pararem de aparecer como
    "Pendente" na DRE (ver `05-problemas-conhecidos.md`) — não é uma
    tarefa de código, é cadastro de dado;
  - **por instrução explícita do usuário, esta etapa parou aqui** — não
    avançar sozinho para emissão real de NF-e (SEFAZ), integração com
    Shopee, IA ou qualquer outra área sem o usuário pedir.
- **Concluído em 24/08/2026, testado localmente (servidor real + Postgres
  local + navegador via Playwright, com os 11 pedidos reais da conta
  PFEMBALAGEMS):** ativação de Contas a Pagar, Contas a Receber e
  Recebimentos (deploy `ml17`) — ver `04-alteracoes.md` (16) e
  `02-decisoes.md` (15). Falta:
  - o usuário subir o próximo zip de código (`ml17`) pro GitHub;
  - depois do deploy, testar as três telas ao vivo em produção:
    cadastrar/editar/excluir/marcar como pago(a) em Contas a Pagar e
    Contas a Receber, e conferir que os dados persistem depois de
    recarregar a página;
  - conferir que o filtro de empresa/período do header funciona nas três
    telas com dados reais de mais de uma empresa (trocar empresa e
    período e ver a tabela/KPIs mudarem);
  - acompanhar Recebimentos com o tempo — se a integração do Mercado
    Livre um dia passar a trazer data de liberação/valor repassado, essa
    tela precisa ser atualizada pra usar o dado real em vez de
    "Informação não disponível" (ver `05-problemas-conhecidos.md`);
  - **por instrução explícita do usuário, esta etapa parou aqui** — não
    avançar sozinho para DRE completa, Faturamento, Notas Fiscais ou
    qualquer outra área sem o usuário pedir.
- **Concluído em 24/08/2026, testado com dados reais localmente (Postgres
  local + Supabase, via MCP):** correção dos 4 bugs de margem achados na
  reconciliação PF ERP x Mercado Turbo (frete duplicado em pedidos do
  mesmo carrinho, comissão não multiplicada pela quantidade, desconto de
  cupom do pagamento não capturado, pedido pago não aparecendo no dia
  certo) — ver `04-alteracoes.md` (15) para o relatório completo, causa
  raiz de cada bug e os testes automatizados (`server/test/`). Falta:
  - o usuário subir o próximo zip de código pro GitHub;
  - depois do deploy, RESSINCRONIZAR os pedidos (histórico e/ou os últimos
    30 dias) pra que os pedidos já existentes no banco de produção sejam
    regravados com o frete/comissão/desconto corrigidos — os 4 bugs só
    afetam pedidos sincronizados a partir de agora; pedidos já no banco
    mantêm os valores antigos (errados) até serem ressincronizados;
  - conferir de novo, pedido a pedido, a reconciliação com o Mercado
    Turbo num dia fechado, com os pedidos ressincronizados, pra confirmar
    que a diferença de R$2,74 (e o pedido que faltava) desapareceram;
  - **decisão pendente:** ver `05-problemas-conhecidos.md` sobre o Bug 3
    (premissa de que o cupom do pagamento sempre reduz a receita do
    vendedor, não confirmada 100% com a API) e sobre o RLS desligado no
    Supabase de produção (achado durante a investigação, não corrigido).
- **Concluído em 24/08/2026, testado só localmente:** unificação das telas
  Produtos e Custo & Margem numa só (Produtos), sem mostrar margem, com
  migração automática dos dados antigos (deploy `ml18`) — ver
  `04-alteracoes.md` (14) e `02-decisoes.md` (14). Falta:
  - o usuário subir o próximo zip de código (`ml18`) pro GitHub;
  - depois do deploy, conferir nos logs do Render que a migração rodou
    (linha `[migrate] migração de dados aplicada: N SKU(s)...`) e só uma
    vez — reiniciar o serviço depois não deve repetir essa linha;
  - abrir a tela Produtos e confirmar que os produtos que já tinham custo
    cadastrado na antiga Custo & Margem aparecem lá, com o custo certo
    (nome = o próprio SKU, pra quem não tinha produto cadastrado ainda —
    vale renomear pra um nome de verdade quando der);
  - confirmar que a alíquota de imposto de cada empresa aparece certa no
    topo da tela Produtos (o mesmo valor que estava configurado antes);
  - conferir que a margem em Pedidos, Visão Geral, Financeiro e no
    Relatório de Pedidos **não mudou** em relação a antes do deploy — os
    números precisam bater exatamente com o que já estava calculado
    (mesma fórmula, só a fonte do custo mudou de tabela);
  - confirmar que a aba "Custo & Margem" sumiu do menu e que a tela
    Produtos não mostra margem em nenhum lugar.
- **Concluído em 24/08/2026, testado só localmente:** Relatório de Pedidos
  (Excel/CSV) e novos filtros de Loja/Status/Produto na tela Pedidos
  (deploy `ml17`) — ver `04-alteracoes.md` (13) e `03-funcionalidades.md`.
  Falta:
  - o usuário subir o próximo zip de código (`ml17`) pro GitHub;
  - depois do deploy, testar os filtros de loja/status/busca ao vivo com
    dados reais, e clicar em "Gerar relatório (Excel)"/"CSV" com pelo
    menos: sem nenhum filtro extra, com um filtro de loja, com um filtro
    de status, e com um período maior (ex: "30 dias") pra também sentir se
    a exportação demora muito nessa empresa;
  - abrir os arquivos baixados e conferir que abrem sem erro (Excel e
    planilha do Google, se possível) e que os totais no fim do relatório
    batem com os números mostrados na tela Pedidos com o mesmo filtro;
  - confirmar visualmente que "Descontos" e os totais fazem sentido com
    pedidos reais que tiveram desconto do Mercado Livre (não testável com
    certeza aqui, já que depende de haver pedido real com
    `preco_unitario_original` diferente do preço cobrado).
  - PDF não foi implementado (não é prioridade agora, por pedido do
    usuário) — considerar quando o usuário pedir.
- **Concluído em 24/08/2026, testado ao vivo em produção:** conceito de
  **produto base + SKU de venda + multiplicador** (deploy `ml15`) — ver
  `04-alteracoes.md` (11) e `03-funcionalidades.md`. Só depois disso, a
  nova tela **Estoque** (Galpão + Full, agrupada por produto base, com
  filtro Todos/Galpão/Full) foi construída reaproveitando essa estrutura —
  ver `04-alteracoes.md` (12). **A tela Estoque nova ainda só foi testada
  localmente** (Postgres local + dados sintéticos batendo o exemplo do
  pedido do usuário) — falta:
  - o usuário subir o próximo zip de código (`ml16`) pro GitHub;
  - depois do deploy, testar os três filtros ao vivo com dados reais da
    empresa (idealmente já com algum produto base cadastrado e com custo,
    e com a conta do Mercado Livre da empresa ativa, pra também confirmar
    o Full ao vivo — hoje a conta de teste local está marcada como
    "erro", então o caminho de Full com sucesso só foi validado com dados
    simulados, não contra a API real);
  - confirmar que produtos base sem nenhum SKU do Mercado Livre vinculado
    ainda aparecem certinho com Full = 0 (não pendente), e que SKUs do
    Full sem vínculo aparecem na lista de pendências da tela, não somados
    a nenhum produto.
  - as antigas telas "Estoque" e "Estoque Full" (com ajuste por produto
    cadastrado em Produtos / visualização separada por anúncio) **foram
    substituídas** por essa tela única — os itens de pendência abaixo
    datados de 23/08/2026 que mencionam essas duas telas antigas ficam
    como histórico, não como trabalho ainda por fazer nelas.
- **Pendência aberta, sem prazo:** não existe ainda uma tela para cadastrar
  produtos base e corrigir manualmente o vínculo SKU → produto base →
  multiplicador — hoje isso só é possível direto pela API
  (`server/routes/produtosBase.js`). A tela Estoque já mostra o produto
  base e o custo, mas cadastrar um produto base novo ou corrigir um
  vínculo errado ainda depende de uma chamada de API manual.
- **Concluído em 24/08/2026:** Supabase como banco principal, migração dos
  dados existentes, sincronização histórica desde 01/07/2026 (3.604
  pedidos, 0 erros) e confirmação de que Visão Geral lê só do banco — ver
  `04-alteracoes.md` (10) e `02-decisoes.md` (12). Por instrução explícita
  do usuário, esta etapa não avançou nenhum outro módulo, e **custo do
  produto e imposto continuam fora do escopo** — a próxima decisão do
  usuário é se/quando entrar nisso.
- **Pendência aberta, sem prazo:** decidir quando desligar o banco antigo
  do Render (`cerne-db`) agora que o Supabase é o principal — ver
  `05-problemas-conhecidos.md`. Também dá pra remover, sem pressa, as
  variáveis de ambiente `SUPABASE_DATABASE_URL` e `ADMIN_MIGRATION_TOKEN`
  do serviço no Render (não são mais usadas).
- Sistema já está no ar (https://cerne-erp.onrender.com), com banco Postgres
  real, **Empresas** funcionando de ponta a ponta, a **integração real com
  o Mercado Livre** (conectar conta, importar pedidos dos últimos 30 dias,
  custo por SKU + imposto configurável) testada com a conta real
  "PFEMBALAGEMS", e **Visão Geral, Pedidos e Financeiro** com dados reais e
  filtro de período — incluindo as 3 correções pedidas depois (filtro
  único no header da Visão Geral, tabela de Pedidos mais estreita, fuso
  horário do período) — testadas ao vivo em produção (ver
  `03-funcionalidades.md` e `04-alteracoes.md`).
- **Produtos, Anúncios e Fornecedores foram implementados e testados
  localmente** (código, schema e queries — ver `04-alteracoes.md` (7) e
  `02-decisoes.md` (10)). **Ainda precisam do teste ao vivo em produção**
  depois que o usuário subir o novo zip pro GitHub e o deploy automático do
  Render terminar — em especial a busca real de anúncios na API do Mercado
  Livre, que não pôde ser testada neste ambiente de desenvolvimento.
- **Estoque, Estoque Full e Compras foram testados ao vivo em produção em
  23/08/2026** (ver `04-alteracoes.md` (9) e `05-problemas-conhecidos.md`):
  - **Estoque** — carregou normalmente (empresa "pf embalegens" ainda sem
    produtos cadastrados, então mostrou o estado vazio correto). O fluxo
    de ajuste de quantidade por linha (que abre um formulário) ainda
    precisa ser conferido ao vivo com um produto real cadastrado — ainda
    não dá pra testar porque a empresa não tem nenhum produto em Produtos.
  - **Estoque Full** — funcionou com dados reais da API do Mercado Livre,
    sem nenhum item em "Pendente". Considerar validado.
  - **Compras** — encontrado e corrigido um bug: o botão "Nova compra" do
    topo não abria o formulário (faltava o evento de clique). **Precisa de
    um novo upload do zip de código pro GitHub e um novo deploy** para a
    correção valer em produção, e depois disso reconferir o botão ao vivo.
- **Pendência aberta, sem prazo:** cadastrar o primeiro produto em
  Produtos (empresa "pf embalegens") para poder testar de ponta a ponta,
  com dado real, o ajuste manual de estoque e a montagem de uma compra
  (seleção de produto no formulário) — hoje as duas telas só têm o estado
  vazio confirmado ao vivo.
- **Pendência aberta, sem prazo:** decidir com o usuário se e quando
  automatizar a entrada de estoque ao marcar uma compra como "Recebido"
  (hoje é 100% manual, por instrução explícita) — inclui decisões de
  negócio como o que fazer com recebimento parcial ou compra editada
  depois de recebida. Ver `05-problemas-conhecidos.md`.
- **RESOLVIDO em 24/08/2026:** custo por SKU usado no cálculo de margem
  (tela Produtos) e custo do produto usado no valor do estoque
  (`produtos_base.custo`, tela Estoque) continuam sendo **duas** fontes
  separadas, sem sincronia entre si — ver `05-problemas-conhecidos.md`.
  (As antigas `produtos.custo` e `custos_produto` foram unificadas nesta
  data; só falta essa última, deliberadamente fora do escopo desta etapa.)
  **Precisa de uma decisão do usuário** sobre unificar também essa (ex:
  produto base virar a fonte única de custo físico) quando fizer sentido.
- **Descoberto no teste ao vivo da correção anterior:** os períodos
  "7 dias" e "30 dias" ficam muito lentos (minutos, chegou a travar a aba)
  em Visão Geral/Pedidos/Financeiro com o volume real de pedidos da conta
  — ver detalhes e causa provável em `05-problemas-conhecidos.md`.
  **Precisa de uma decisão do usuário** sobre corrigir isso agora ou depois
  (ficou fora do escopo das etapas pedidas até aqui, então não foi mexido).
- Por instrução explícita do usuário, esta etapa também termina depois do
  teste nas três telas novas (Estoque, Estoque Full, Compras) — aguardando
  o usuário pedir o próximo módulo (ou alguma das pendências acima) antes
  de avançar (não avançar sozinho pra contas a pagar/receber, DRE completa,
  Ads, notas fiscais, Shopee, IA de compras, automação de entrada de
  estoque, etc., nem pra unificar Produtos com Custos sem o usuário
  decidir).
- **Pendente do usuário:** configurar no painel de desenvolvedor do
  Mercado Livre a notificação do tópico `orders_v2` apontando para
  `https://cerne-erp.onrender.com/api/integracoes/mercadolivre/webhook`,
  pra ativar o pedido caindo sozinho no sistema. Depois de configurado,
  confirmar com um pedido real que ele aparece sem precisar clicar em
  "Sincronizar" (ver `05-problemas-conhecidos.md`).
- Se o usuário quiser, otimizar a velocidade da sincronização do Mercado
  Livre para contas com muitos pedidos (ver `05-problemas-conhecidos.md`) —
  não fazer sem o usuário pedir.
- Verificar, com o usuário, se surgiu alguma forma de habilitar `git push`
  direto nesta sessão do Cowork (ver `05-problemas-conhecidos.md`); enquanto
  isso, seguir com o fluxo de zip manual.
