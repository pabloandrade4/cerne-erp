# Próximos Passos

- **Concluído em 27/08/2026 — Etapa (b) da "IA Gestora que conhece o
  negócio" implementada — camada de contexto de negócio, raio-X da
  empresa, `identificar_produto_fisico` e "produto em foco" (testado:
  Postgres real, **386/386 testes automatizados no projeto** (era
  368/368) + verificação manual: servidor sobe normalmente com a migração
  nova, as 2 ferramentas testadas diretamente contra dado real da empresa
  900 — ver `04-alteracoes.md` (42) e `02-decisoes.md` (42)).** Depois da
  Etapa (a) (Mapa de Produtos), a Etapa (b) da ordem aprovada foi
  concluída: `server/lib/mapaProdutos.js#identificarProdutoFisico`
  (cascata de 4 camadas, nunca escolhe sozinha entre candidatos
  ambíguos), `server/lib/ia/contextoNegocio.js#montarRaioXEmpresa`
  (composição sobre `painelVisaoGeral`/`recebimentosMl`, nenhum cálculo
  novo), 2 ferramentas novas de IA (`identificar_produto_fisico`,
  `visao_geral_empresa`) e o mecanismo de "produto em foco" (coluna nova
  `ia_conversas.contexto_ativo`). Um bug real (query com `JOIN` sem
  qualificar coluna ambígua) foi encontrado pelos próprios testes e
  corrigido — ver `04-alteracoes.md` (42). **Falta (próximas etapas da
  proposta, na ordem aprovada):**
  1. **Etapa (c)** — regras de negócio declaradas pelo usuário
     (`regras_negocio_ia`), sempre com confirmação explícita antes de
     gravar — o único write-exception que a proposta permite pra IA
     (`definir_regra_negocio`, sempre gated atrás de confirmação explícita
     do usuário na mesma conversa);
  2. **Etapa (d)** — tabela `tarefas` ligada ao Radar já existente (alerta
     → tarefa, sempre por ação explícita, nunca automática por padrão);
  3. **Etapa (e)** — integração de WhatsApp, bloqueada até o usuário
     escolher o provedor (Meta Cloud API / Twilio / Z-API / outro) e
     fornecer as credenciais — mesma pendência de padrão já usada pra
     `IA_API_KEY`;
  4. testar ao vivo, numa conversa real (depois de `IA_API_KEY` estar
     configurada em produção), as perguntas de acompanhamento que a Etapa
     (b) foi desenhada pra resolver — ex: "quanto tenho da caixa
     20x20x20?" seguido de "e quanto vendi dela essa semana?" — hoje só
     verificado no nível da ferramenta/orquestrador com provedor falso
     (ver `05-problemas-conhecidos.md`);
  5. **se o usuário quiser** (não pedido ainda): a IA passar a sugerir
     apelidos automaticamente (`origem: 'ia_sugerido'`, sempre com
     confirmação) a partir de padrões percebidos em conversas reais — o
     schema já suporta, só falta a ferramenta.

- **Concluído em 27/08/2026 — Recebimentos + Fluxo de Caixa + IA Gestora:
  organização de recebimentos, importação de extrato bancário com
  conciliação, e 3 ferramentas novas somente leitura pra IA (testado:
  Postgres real, 351/351 testes automatizados no projeto + verificação
  manual ao vivo via `curl` reproduzindo os 4 primeiros cenários
  obrigatórios contra dados reais da empresa 900 — ver
  `04-alteracoes.md` (40) e `02-decisoes.md` (40)).** Os 3 passos pedidos
  foram implementados e testados de ponta a ponta na lógica de backend e
  na tela (frontend em `server/public/index.html`, módulos
  `window.Recebimentos` e `window.FluxoCaixa`). **Falta:**
  1. **confirmar ao vivo em produção depois do deploy** — importar uma
     planilha real de extrato bancário (a planilha de verdade do usuário,
     não o CSV sintético usado nos testes) e conferir visualmente o
     assistente de importação, o histórico e o painel de sugestões de
     conciliação num navegador real;
  2. testar as 3 perguntas obrigatórias em português ("Quanto já recebi
     este mês?", "Quanto ainda tenho para receber?", "Como fica meu fluxo
     de caixa nos próximos 30 dias?") numa conversa real assim que
     `IA_API_KEY` estiver configurada em produção (ver
     `05-problemas-conhecidos.md`) — hoje só verificado no nível da
     ferramenta, sem o modelo de verdade;
  3. **se o usuário quiser** (não pedido nesta etapa): uma tela de
     detalhe por movimentação dentro de uma importação específica, um
     jeito de estornar/desfazer uma importação feita por engano, e uma
     visão consolidada de sugestões de conciliação somando todas as
     contas bancárias de uma vez (hoje é uma conta por vez) — ver
     `05-problemas-conhecidos.md`;
  4. recebimentos de marketplace continuam só Mercado Livre — Shopee
     entraria numa etapa própria, se e quando o usuário pedir.

- **Concluído em 26/08/2026 — Análise ganha 3 abas: Performance de
  Anúncios, Visitas e Conversão, Margem por Anúncio (testado: Postgres
  real com dados de vendas reais da empresa 900 + Playwright para as 3
  telas e o modal de detalhe + 30 testes automatizados novos, 315/320 no
  total no projeto — ver `04-alteracoes.md` (34) e `02-decisoes.md`
  (34)).** As 3 abas foram implementadas e testadas de ponta a ponta com
  dados reais de vendas; números conferidos e batendo exatamente com
  `/api/relatorios/resumo-vendas` (mesma fonte). **Falta:**
  1. **conferir o formato real da resposta da API de Visitas do Mercado
     Livre** assim que houver uma conta com token válido (as 2 contas
     deste ambiente estão com token expirado) — ver
     `05-problemas-conhecidos.md` para o endpoint exato e o que ajustar em
     `lib/mlVisitas.js` se o formato divergir do esperado;
  2. testar preço/status/estoque ao vivo (Performance de Anúncios) e o
     catálogo completo paginado contra uma conta real, pelo mesmo motivo;
  3. confirmar ao vivo em produção depois do deploy;
  4. **decisão do usuário, sem prazo:** os 5 testes pré-existentes de
     `test/financeiro.test.js` que falham por sensibilidade de data (não
     relacionados a esta tarefa, ver `05-problemas-conhecidos.md`) — vale
     abrir uma tarefa própria pra corrigir.

- **Concluído em 25/08/2026 — Despesas Fixas + Fluxo de Caixa (2 abas
  novas em Financeiro, testado: Postgres real via `curl` + 20 testes
  automatizados novos, 290/290 no total no projeto, 0 falhas — ver
  `04-alteracoes.md` (33) e `02-decisoes.md` (33)).** Os 3 passos pedidos
  foram implementados e testados na lógica de backend de ponta a ponta
  (cadastro de despesa fixa, geração automática de conta a pagar sem
  duplicar mesmo rodando 2x, fluxo de caixa com REALIZADO x PROJETADO e a
  fórmula pedida). **Falta:**
  1. testar a tela num navegador real (este ambiente de desenvolvimento
     não tem acesso a um navegador nesta etapa — ver
     `05-problemas-conhecidos.md`): abrir Despesas Fixas, cadastrar uma
     despesa, clicar em "Gerar agora" e conferir que ela aparece em
     Contas a Pagar; abrir Fluxo de Caixa, definir um saldo inicial e
     conferir os cards/gráfico/tabela;
  2. confirmar ao vivo em produção depois do deploy;
  3. **decisão do usuário, sem prazo:** se/quando integrar recebimentos da
     Shopee, somar essa fonte também em "recebimentos previstos dos
     marketplaces" no Fluxo de Caixa (hoje só cobre Mercado Livre — ver
     `05-problemas-conhecidos.md`).

- **Concluído em 25/08/2026 — parte 2 (Ads: diagnóstico real, endpoints
  ATUAIS de Product Ads e sincronização em banco, testado: Postgres real +
  API mockada, 270 testes automatizados no total no projeto, 0 falhas —
  ver `04-alteracoes.md` (32) e `02-decisoes.md` (32)).** Os 3 passos
  pedidos foram implementados e testados na orquestração/persistência; **o
  único item que falta é a confirmação ao vivo em produção**, porque este
  ambiente de desenvolvimento não tem acesso à internet nem a uma conta
  Mercado Livre real (mesma limitação de sempre, ver
  `05-problemas-conhecidos.md`):
  1. depois do deploy, abrir a tela Ads com a conta real conectada (ou
     clicar em "Sincronizar agora") e conferir se o motivo/mensagem que
     aparecem agora mudaram de "Nenhuma conta de anunciante encontrada"
     para algo mais específico — isso já confirma se a causa era o
     `user_id` faltando ou não;
  2. se ainda aparecer erro, olhar `ads_contas.detalhe_api` (ou a mensagem
     já traduzida na tela, que agora cita a causa real devolvida pelo
     Mercado Livre) — o próximo ajuste de endpoint/parâmetro, se precisar,
     parte desse dado real, não de mais leitura de documentação;
  3. se sincronizar com sucesso, comparar investimento/cliques/impressões/
     ROAS/ACOS mostrados na tela com o painel real de Product Ads do
     Mercado Livre, pra confirmar que os campos foram lidos certo;
  4. considerar se o intervalo de sincronização (15 min,
     `ADS_SYNC_INTERVALO_MS`) e a janela da série diária (40 dias,
     `ADS_SYNC_DIARIO_DIAS`) fazem sentido no uso real, ou se o usuário
     quer ajustar.
- **Concluído em 25/08/2026 (Radar da IA — acompanhamento contínuo do
  negócio em segundo plano, análise automática de anúncios, negócio
  inteiro e alertas 🔴🟠🟢🔵, testado: Postgres real, 257 testes
  automatizados, 0 falhas — ver `04-alteracoes.md` (31) e
  `02-decisoes.md` (31)).** Depois de rodar em produção por um tempo com
  dados reais, vale revisar com o usuário:
  1. os limiares declarados em `lib/ia/radarConfig.js` (ex.: "vendeu ≤5
     unidades em 30 dias" para "venda baixa", "estoque cobre ≤7 dias"
     para "crítico") — foram escolhidos como ponto de partida razoável,
     não validados contra o histórico real de nenhuma empresa ainda;
  2. o intervalo do ciclo (15 min, `IA_RADAR_INTERVALO_MS`) — se 15 min
     é rápido/devagar demais no uso real;
  3. considerar expor os limiares numa tela de configuração (hoje só por
     variável de ambiente/código) se o usuário quiser ajustar sem pedir
     uma alteração no sistema;
  4. quando houver uma `IA_API_KEY` de produção válida (mesma pendência
     de sempre, ver `05-problemas-conhecidos.md`), conferir ao vivo que
     as recomendações escritas pela IA para situações novas/escaladas
     saem coerentes e realmente úteis (hoje só testado com a
     `recomendacaoPadrao` determinística, já que a chave não está
     configurada nesta sandbox).
- **Concluído em 25/08/2026 (IA Gestora vira central de análise e
  relatórios — login real só nesta área, histórico de conversas no banco,
  cards visuais e planilha XLSX automática, testado localmente: Postgres
  real + servidor real via HTTP + IA mockada, 3 arquivos de teste novos —
  251 testes no total no projeto com Postgres, 0 falhas):** ver
  `04-alteracoes.md` e `02-decisoes.md` (30). **Não precisa de nenhuma
  variável de ambiente nova no Render** (diferente da Shopee) — tudo usa
  pacotes/módulos já presentes (`crypto` nativo do Node, `express`, `pg`,
  `exceljs`); só o opcional `IA_SESSAO_DIAS` (quantos dias uma sessão de
  login dura, padrão 30) existe, e não precisa ser definido. Falta, **nesta
  ordem**:
  1. o usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto);
  2. **criar o primeiro (e cada) login da IA Gestora rodando este comando
     no servidor** (não existe tela de "criar conta" — decisão registrada
     em `02-decisoes.md` (30)):
     `node db/criarUsuarioIa.js "email@empresa.com" "SenhaForte123" "Nome"`
     — troque o e-mail/senha/nome pelos reais; a senha precisa ter pelo
     menos 8 caracteres; rodar de novo com o mesmo e-mail atualiza a senha
     e o nome desse usuário (não cria duplicado);
  3. testar ao vivo, com o login criado, o checklist pedido pelo usuário:
     a) abrir a IA Gestora, fazer login, atualizar a página e confirmar que
        continua logado e a conversa (se houver) continua na tela;
     b) fazer uma pergunta, sair da IA Gestora e voltar (ou fechar e abrir
        o navegador de novo), abrir a conversa antiga pela sidebar e
        confirmar que o histórico está completo;
     c) pedir uma análise maior (ex.: "Faça uma análise completa das
        caixas que mais faturaram este mês.") e confirmar que a resposta
        vem com resumo/KPIs/tabela/gráfico, não só texto;
     d) clicar em "Baixar planilha (XLSX)" nessa mesma resposta e abrir o
        arquivo baixado;
     e) conferir, número a número, que o valor mostrado na tela, o texto
        da resposta da IA e a planilha baixada são idênticos;
  4. se algum dia for necessário limitar quais empresas cada usuário pode
     ver (hoje qualquer usuário logado vê qualquer empresa ativa — ver
     `05-problemas-conhecidos.md`), isso é um projeto à parte que toca o
     ERP inteiro (`routes/empresas.js`, o seletor do cabeçalho
     compartilhado com todas as telas), não só a IA Gestora — não fazer
     sem o usuário pedir explicitamente.
  - **Por instrução explícita do usuário, esta etapa parou aqui** —
    nenhum outro módulo do ERP foi alterado, nenhum cálculo financeiro
    mudou, nenhum acesso de escrita foi dado à IA.
- **Concluído em 25/08/2026 (conectar a Shopee ao ERP — Open Platform v2,
  só autorização + renovação de token, testado localmente: Postgres real +
  Express real via HTTP, 24 testes de integração novos — 227 testes no
  total no projeto com Postgres, 0 falhas):** ver `04-alteracoes.md` e
  `02-decisoes.md` (29). **Bloqueado só pela falta de credenciais reais da
  Shopee Open Platform** (nenhuma foi configurada nesta sessão) — nenhuma
  outra ação de código é necessária. Falta, **nesta ordem**:
  1. **Criar o app na Shopee Open Platform** (https://open.shopee.com,
     seção de desenvolvedor/parceiro) e obter **Partner ID** e **Partner
     Key** — a categoria "live" costuma exigir aprovação da Shopee antes
     de liberar credenciais de produção; a categoria de teste/sandbox
     libera na hora e é o caminho recomendado pra validar a conexão
     primeiro (ver passo 3).
  2. **Cadastrar a URL de callback no painel do app da Shopee** — campo
     costuma se chamar "Redirect URL"/"Authorization Callback URL":
     `https://cerne-erp.onrender.com/api/integracoes/shopee/callback`
     (mesmo domínio já usado pelo Mercado Livre, caminho novo). Precisa
     bater **exatamente** com essa URL, senão a Shopee recusa a
     autorização.
  3. **Configurar no Render (Settings → Environment) exatamente estas
     variáveis:**
     - `SHOPEE_PARTNER_ID` — o Partner ID obtido no passo 1 (só números).
     - `SHOPEE_PARTNER_KEY` — o Partner Key obtido no passo 1 (nunca
       compartilhar nem colar em nenhum outro lugar além do Render —
       nunca vai para o front-end nem para o GitHub).
     - `SHOPEE_TOKEN_KEY` — uma chave só do ERP (nunca vem da Shopee),
       32 bytes em base64, pra criptografar os tokens no banco (mesma
       ideia de `ML_TOKEN_KEY`, mas uma chave própria da Shopee). Gerar
       uma nova rodando, uma única vez, neste terminal/servidor:
       `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
       — colar o resultado direto no Render, nunca reaproveitar o valor
       de `ML_TOKEN_KEY`.
     - `SHOPEE_HOST` (opcional) — só se quiser testar primeiro contra o
       ambiente de testes da Shopee antes de ir pra produção: definir como
       `partner.test-stable.shopeemobile.com`. Sem essa variável, o ERP já
       usa produção (`partner.shopeemobile.com`) por padrão.
     - `SHOPEE_REDIRECT_URI` (opcional) — só se quiser sobrescrever a URL
       calculada automaticamente pelo servidor (protocolo + host da
       requisição); normalmente não precisa ser definida.
  4. O usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto).
  5. Testar ao vivo os 5 pontos pedidos pelo usuário, na tela
     **Marketplaces**, abaixo do bloco do Mercado Livre:
     a) clicar em "Conectar Shopee" — deveria abrir a página de
        autorização da própria Shopee (nunca dentro do ERP);
     b) autorizar/selecionar a loja lá e confirmar que a Shopee redireciona
        de volta pro ERP, caindo em Marketplaces com um aviso de sucesso;
     c) confirmar que a loja aparece como "Conectada", com Shop ID, nome
        (quando a Shopee retornar), empresa vinculada e "Última
        atualização" preenchidos;
     d) esperar (ou usar o botão "Renovar token") e confirmar, olhando o
        campo "Token de acesso expira em", que o valor muda depois de uma
        renovação — automática (ciclo a cada 30min, ver
        `lib/shopeeTokenScheduler.js`) ou manual;
     e) reiniciar o servidor (redeploy no Render já serve como teste) e
        confirmar que a loja continua aparecendo como conectada — nenhum
        estado depende da memória do processo, só do Postgres.
  6. **Se algo der errado na autorização** (ex.: mensagem de "wrong sign"
     ou assinatura inválida), ver `05-problemas-conhecidos.md` — o
     primeiro lugar a olhar é `lib/shopee.js#assinar`, testando primeiro
     contra `SHOPEE_HOST=partner.test-stable.shopeemobile.com`.
  - **Por instrução explícita do usuário, esta etapa parou aqui** — nenhum
    pedido, estoque, Ads nem financeiro da Shopee foi implementado; não
    avançar sozinho pra essas áreas sem o usuário pedir depois de validar
    que a conexão está estável.
- **Concluído em 25/08/2026 (IA Gestora ganha raciocínio/projeção —
  ferramenta `projecao_mes`, catálogo de 19 para 20, testado localmente:
  Postgres real, 6 testes de integração novos + verificação manual das 3
  perguntas do checklist do usuário contra `executarFerramenta` — 203
  testes no total no projeto com Postgres, 0 falhas):** ver
  `04-alteracoes.md` e `02-decisoes.md` (28). **Ainda bloqueado pela mesma
  falta de `IA_API_KEY` de produção válida** (ver `05-problemas-
  conhecidos.md`) — nenhuma ação nova é necessária além do que já estava
  pendente. Falta, **nesta ordem, assim que o usuário configurar a
  chave**:
  1. o usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto) e confirmar `IA_API_KEY` configurada;
  2. testar ao vivo, com dado real, as 3 perguntas específicas deste
     pedido: "Faça uma projeção do meu faturamento até o final deste
     mês.", "Se continuar neste ritmo, qual será meu lucro no final do
     mês?", "Compare o ritmo dos últimos 7 dias com a média do mês." —
     confirmando que o modelo escolhe `projecao_mes` sozinho (sem precisar
     de dica) e que a resposta separa claramente REALIZADO de PROJETADO,
     no formato pedido pelo usuário;
  3. testar também perguntas que antes eram recusadas indevidamente (o bug
     original relatado) e confirmar que a IA agora tenta combinar
     ferramentas antes de dizer que "não tem essa funcionalidade";
  4. comparar cada resposta da IA com a tela correspondente do ERP —
     número a número; se houver qualquer divergência, corrigir a origem
     antes de considerar concluído;
  - **por instrução explícita do usuário, esta etapa parou aqui** — nenhum
    acesso de escrita foi dado à IA; não avançar sozinho para a IA poder
    alterar dados nem para ações automáticas, sem o usuário pedir depois
    de validar as respostas acima.
- **Concluído em 25/08/2026 (catálogo da IA Gestora ampliado para 19
  ferramentas — "inteligência central", testado localmente: Postgres real
  + servidor real via HTTP, 13 testes de integração novos comparando cada
  ferramenta número a número contra a função canônica do ERP — 197 testes
  no total no projeto com Postgres/64 sem, 31 suítes, 0 falhas):** ver
  `04-alteracoes.md` e `02-decisoes.md` (27). **Ainda bloqueado pela mesma
  falta de `IA_API_KEY` de produção válida** (ver `05-problemas-
  conhecidos.md`) — nenhuma ação nova é necessária além do que já estava
  pendente. Falta, **nesta ordem, assim que o usuário configurar a
  chave**:
  1. o usuário subir o próximo zip de código pro GitHub (deploy automático
     no Render cuida do resto) e confirmar `IA_API_KEY` configurada;
  2. testar ao vivo, com dado real, as 10 perguntas do checklist pedido
     pelo usuário: "Quanto faturei hoje?", "Qual minha margem de
     contribuição hoje?", "Quanto tenho para pagar?", "Quanto tenho para
     receber?", "Qual SKU mais vendeu este mês?", "Qual modelo de caixa
     mais vendeu em unidades físicas?", "Quanto gastei com Ads este mês?",
     "Quais anúncios tiveram pior resultado?", "Como está meu fluxo de
     caixa?", "Faça um resumo executivo do meu negócio este mês.";
  3. comparar cada resposta da IA com a tela correspondente do ERP
     (Visão Geral/Pedidos/Financeiro/DRE/Relatórios/Ads/Contas a
     Pagar/Receber) pro mesmo período — número a número; se houver
     qualquer divergência, corrigir a origem (a ferramenta ou a função
     canônica que ela usa) antes de considerar concluído, exatamente como
     pedido pelo usuário;
  4. confirmar que perguntas fora do que as ferramentas cobrem (ex:
     Shopee, "estoque por caixa") são respondidas com honestidade em vez
     de uma resposta inventada;
  5. informar ao usuário, ao final, quais módulos a IA já consegue
     consultar com segurança e quais ainda não têm dado suficiente (esta
     etapa cumpriu essa parte no nível técnico — ver `03-funcionalidades.md`
     — falta só confirmar com o usuário depois do teste ao vivo);
  - **por instrução explícita do usuário, esta etapa parou aqui** — nenhuma
    ação automática foi implementada (todas as 10 ferramentas novas são só
    leitura); não avançar sozinho para a IA poder alterar dados, nem para
    alertas automáticos proativos, sem o usuário pedir depois de validar
    as respostas acima.
- **Concluído em 25/08/2026 (parte 1 de 3 da ativação da IA Gestora,
  testado localmente — Postgres real + servidor real via HTTP + chamada
  ao vivo com chave inválida contra `api.anthropic.com`, 185 testes com
  Postgres/64 sem, 0 falhas):** provedor de IA corrigido/confirmado
  contra a API real, erros categorizados em 5 tipos com mensagem clara
  (nunca erro técnico bruto) — ver `04-alteracoes.md` e `02-decisoes.md`
  (26). **Único passo restante para o chat responder de verdade:**
  configurar `IA_API_KEY` no Render com uma chave real da conta Anthropic
  do usuário. O usuário pediu explicitamente para não avançar mais nesta
  etapa ("Não conecte ainda a IA aos módulos do ERP. Não implemente
  alertas automáticos. Não altere outras áreas") — a conexão com dados do
  ERP e alertas automáticos já existem de uma etapa anterior (28/08/2026)
  mas não foram tocados aqui; próximos passos possíveis, **não pedidos
  ainda**: (1) validar ao vivo, com a chave real configurada, que as
  perguntas que USAM dados do ERP (ex: "quanto vendi hoje") respondem
  certo; (2) revisitar se o usuário quiser alertas automáticos ou dar à
  IA permissão para alterar dados do sistema.
- **Concluído em 25/08/2026, testado localmente (Postgres real + servidor
  real via HTTP, `periodo=hoje` e `periodo=mes` conferidos manualmente —
  166 testes automatizados no total no projeto com Postgres, 51 sem, 0
  falhas):** correção e ativação da tela Ads — API de Advertising
  corrigida contra a documentação oficial, cards de topo, gráfico diário e
  ranking por anúncio dividido em duas visões separadas — ver
  `04-alteracoes.md` e `02-decisoes.md` (25). **O usuário pediu
  explicitamente para parar depois desta correção** ("Pare depois dessa
  correção") — nenhuma expansão adicional foi feita. Candidato a próximo
  passo, **não pedido ainda**, só possível com acesso a uma conta
  Mercado Livre real com Product Ads habilitado (ver
  `05-problemas-conhecidos.md`): confirmar ao vivo em produção que os
  endpoints/parâmetros corrigidos (`advertiser_id` no path, métricas do
  endpoint de itens, `aggregation_type=daily`, endpoint de campanhas)
  batem exatamente com a resposta real da API, e comparar o gasto exibido
  nos cards com o painel real do Mercado Livre.
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
