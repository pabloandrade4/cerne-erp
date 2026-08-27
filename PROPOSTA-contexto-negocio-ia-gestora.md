# Proposta de arquitetura — IA Gestora que conhece o negócio

**Status: PROPOSTA, aguardando aprovação. Nada foi implementado.**
Documento de resposta ao pedido "REQUISITO CENTRAL — A IA GESTORA PRECISA CONHECER MEU NEGÓCIO". Segue exatamente a ordem pedida: primeiro a auditoria (seção 25 do pedido), depois a arquitetura proposta, depois as 10 respostas finais.

---

## PARTE 1 — AUDITORIA DO QUE JÁ EXISTE

Feita lendo o código real (não por suposição). Cada afirmação abaixo cita arquivo/tabela.

### 1.1 Produtos

- **Tabelas:** `produtos` (SKU comercial + custo + empresa — fonte única de custo desde 24/08/2026), `produtos_base` (produto físico: código, nome, custo por unidade física), `produto_base_skus` (vínculo SKU → produto_base + multiplicador de kit + origem `manual`/`automatico`). Também existem `custos_produto` (legado, substituído por `produtos`), `estoque`/`estoque_movimentos` e `estoque_produto_base`/`_movimentos` (ambos legados/congelados desde 26/08/2026 — estoque real hoje é só `ml_estoque_itens`, ver 1.3).
- **SKU → produto físico já funciona e é bem desenhado.** `lib/relatoriosAgregados.js#resolverProdutosBasePorSku`: 1) vínculo salvo em `produto_base_skus` sempre tem prioridade; 2) sem vínculo, tenta um regex (`lib/skuProdutoBase.js`) que lê dígitos no início do SKU como multiplicador (`100CX-19X12X12` → 100 × `CX-19X12X12`); 3) sem padrão nenhum, **nunca chuta** — fica em "sem produto base identificado", separado. Existe um segundo caminho parecido (`lib/produtoBaseConversao.js`), só com vínculo salvo, sem regex — usado pela API de conversão.
- **Faltando, confirmado por grep no schema inteiro:** nenhuma coluna de **medida** (dimensão) — só existe embutida em texto no `codigo`/`sku`. Nenhuma tabela de **categoria** de produto. Nenhuma tabela de **aliases**/apelidos. Nenhum **histórico de custo** — `produtos.custo`/`produtos_base.custo` são sobrescritos in-place, sem versão/data.
- **Gap crítico de produto:** `produtos_base`/`produto_base_skus` têm uma API REST completa (`routes/produtosBase.js`) mas **nenhuma tela usa essa API** — grep por `/api/produtos-base` em `public/index.html` não encontra nada. Ou seja, hoje só é possível cadastrar/corrigir um vínculo SKU→produto físico direto no banco ou por chamada HTTP manual. Isso é uma trava real para tudo que depende dessa resolução (Estoque Full com valor a custo, a própria IA).

### 1.2 Vendas / Pedidos / Marketplaces

- **Tabelas:** `ml_pedidos`, `ml_pedido_itens`, `ml_pedido_pagamentos` (com `coupon_amount`). Cancelamento é só `ml_pedidos.status='cancelled'` (excluído dos totais, mostrado à parte). **Devolução não existe como conceito** — zero tabela/coluna, só duas menções em comentário sobre um caso hipotético de mudança tardia de status.
- **Fórmula de margem** (`lib/resultadoVenda.js`): venda líquida (após cupom) − taxas ML − frete vendedor − imposto − custo do produto = margem de contribuição. Qualquer campo faltando → resultado `null` (nunca estimado). Bem centralizado, reaproveitado por Pedidos/Visão Geral/Financeiro/DRE/IA — **fonte única real, não uma promessa**.
- **Não existe tabela `lojas`.** A hierarquia real é `empresas` → `ml_contas`/`shopee_contas` (uma conta de marketplace por empresa) → "loja" é só o `nickname` da conta, exibido como texto (nem `ml_estoque_itens.loja` é uma FK, é uma cópia desnormalizada do nickname).
- **Shopee: só OAuth funciona.** `lib/shopee.js` implementa autenticação/renovação de token — **nenhum pedido, estoque, Ads ou financeiro da Shopee está integrado** (comentário explícito no próprio arquivo).
- **Não existe "metas"** (meta de faturamento/margem) em lugar nenhum do schema ou do código.

### 1.3 Estoque

- **Só uma tabela viva:** `ml_estoque_itens`, com `tipo IN ('proprio','full')` — essa é a única distinção Full/fora-do-Full que existe. **"Em trânsito" não existe** (zero resultado em todo o grep do projeto).
- Sincronizado a cada ciclo do `lib/syncScheduler.js` (mesmo ciclo de 1 min dos pedidos) via `lib/mlEstoque.js` — nunca lido ao vivo pelas telas (`routes/estoque.js`/`estoqueFull.js` são espelhos read-only do banco).
- `lib/estoqueFisico.js` já converte quantidade de anúncio → unidades físicas (usando a mesma resolução de kit do item 1.1) e valoriza a custo (`produtos_base.custo`) — é o motor que a IA já usa para "quanto vale meu estoque".
- **Giro de estoque não existe** (comentário explícito no código dizendo que essa telemetria não existe). **Cobertura em dias já existe**, mas só dentro do Radar da IA (`lib/ia/radarNegocio.js`, com limites 7/14/120 dias) — não é uma ferramenta de consulta direta da IA nem aparece em nenhuma tela. **Ponto de reposição/estoque mínimo configurável não existe.**

### 1.4 Financeiro

Todos os módulos já mapeados em detalhe nas últimas entregas (Contas a Pagar/Receber, Despesas Fixas, Fluxo de Caixa, DRE, Recebimentos de marketplace, Extrato bancário + conciliação, Compras). Resumo do que falta:
- **Despesas variáveis:** não existe como conceito (só "despesas fixas").
- **Metas financeiras:** não existem.
- **CMV:** não é um nome/linha isolada — está embutido dentro do cálculo de margem, e a DRE expõe como `custoProdutos`.
- **Tarefas / lembretes / WhatsApp: nada disso existe hoje.** Não há tabela `tarefas`, nenhuma integração de WhatsApp, nenhum "lembrete".
- **`radar_alertas` já existe e é sofisticado**, mas é **puramente detecção automática read-only**: um alerta nasce quando uma regra bate, marca `resolvido` sozinho quando para de bater — não existe checkbox de usuário, não vira tarefa, não dispara notificação externa nenhuma.

### 1.5 IA atual — a parte mais relevante para este pedido

- **25 ferramentas hoje** (`lib/ia/ferramentas.js`), cada uma uma casca fina sobre uma função já validada do ERP (nunca uma fórmula nova). Cobrem: vendas/margem, produtos (por SKU e por caixa física), estoque (resumo + valor físico a custo + detalhado), contas a pagar/receber, recebimentos de marketplace, os 2 fluxos de caixa (simples e detalhado + extrato bancário), DRE completa, compras, notas fiscais, Ads, comparação com período anterior, projeção de mês, e uma base de conhecimento estática (`consultar_documentacao`).
- **`empresaId` e período nunca são parâmetro do modelo** — vêm sempre do filtro do cabeçalho, nunca de texto de chat (estruturalmente impossível a IA misturar empresa — comentário explícito no código confirma essa é uma decisão deliberada, não um acidente).
- **O que a IA NÃO tem hoje, confirmado por leitura completa do código (não suposição):**
  1. **Nenhuma memória entre perguntas além da própria transcrição da conversa** — `criarContexto` monta um objeto novo, do zero, a cada pergunta HTTP; nada é cacheado/persistido entre perguntas ou entre conversas.
  2. **O histórico da conversa é truncado nas últimas 8 mensagens (2000 caracteres cada)** — turnos mais antigos são descartados, não resumidos.
  3. **Nenhum lugar guarda uma regra/preferência que o usuário declarou** ("minha margem mínima é 15%") para reuso futuro — zero coluna, zero tabela, zero cache.
  4. **Nenhuma ferramenta resolve "aquela caixa 16x11x6" ou "a 16 por 11 por 6" para um produto físico** — a resolução de SKU→produto existe (item 1.1), mas só é chamada internamente por ferramentas que já recebem um SKU exato; não existe uma ferramenta de entrada em linguagem natural.
  5. **Nenhuma função de "raio-x da empresa"** dedicada — mas o equivalente já existe espalhado: `lib/visaoGeralPainel.js#painelVisaoGeral` já combina vendas, margem, recebimentos, alertas, conexões numa função só (é o motor da tela Visão Geral). Isso muda a proposta: não é preciso inventar do zero, é preciso **compor** o que já existe.
  6. **Nada liga um alerta do Radar a uma ação** (tarefa, lembrete, WhatsApp).

### 1.6 Conhecimento ausente — lista objetiva

| Falta | Onde doeria existir hoje |
|---|---|
| Medida/dimensão do produto físico como campo estruturado | `produtos_base` |
| Categoria de produto | `produtos_base` |
| Aliases/apelidos em linguagem natural | novo |
| Histórico de custo (não só o valor atual) | `produtos`/`produtos_base` |
| Tela de gestão de produto físico/vínculo de SKU | `produtos_base`/`produto_base_skus` já têm API, falta UI |
| Devolução como conceito rastreado | `ml_pedidos` |
| "Loja" como entidade própria (hoje é nickname de texto) | decisão consciente do projeto — ver nota abaixo, não necessariamente um problema |
| Metas (faturamento, margem, cobertura) | novo |
| Despesas variáveis | novo (ou decisão de que "despesas fixas" cobre o suficiente) |
| Giro de estoque | novo (cobertura já existe, mas só dentro do Radar) |
| Ponto de reposição / estoque mínimo configurável | novo |
| Regra de negócio declarada pelo usuário (memória controlada) | novo |
| Tarefas / lembretes | novo |
| Integração WhatsApp | novo (integração externa, precisa de credencial do usuário) |
| Resolução de linguagem natural → produto físico | novo (ferramenta nova sobre estrutura já existente) |
| "Raio-X" como ferramenta explícita para a IA | compor o que já existe, não recriar |

> Nota sobre "loja": não tratar como bug — é uma decisão consciente já tomada no projeto (loja = nickname da conta de marketplace, não uma entidade própria com regras próprias). Só vira um problema real se o usuário quiser, no futuro, atribuir regras/metas por loja individualmente — hoje não há pedido nesse sentido.

---

## PARTE 2 — ARQUITETURA PROPOSTA

### 2.1 Princípio geral

```
MARKETPLACES
     ↓
SINCRONIZAÇÕES  (já existem: mlSync, mlEstoque, syncScheduler — não mexer)
     ↓
BANCO DO ERP  (tabelas já existentes + as poucas novas abaixo)
     ↓
CAMADA DE CONTEXTO DE NEGÓCIO  (nova — o "cérebro estrutural", não um cache paralelo)
     ↓
FERRAMENTAS DA IA  (as 25 já existentes + as novas propostas abaixo)
     ↓
IA GESTORA  (orchestrator.js, sem reescrever o que já funciona)
```

A regra de ouro que rege toda a proposta: **a camada nova organiza e resume o que já existe no banco — ela nunca é uma segunda fonte de verdade.** Todo dado dinâmico continua vindo de uma consulta real no momento da pergunta (nunca um cache que pode ficar velho); só o que é estruturalmente estável (mapa de produtos, regras declaradas) é persistido.

### 2.2 Nome da camada nova, seguindo o padrão do projeto

O projeto usa nomes em português, descritivos, sem sigla — `ferramentas.js`, `estrutura.js`, `baseConhecimento.js`, `radar*.js` (a única exceção histórica é `orchestrator.js`). Proposta:

- **`server/lib/ia/contextoNegocio.js`** — a camada central (equivalente ao "Business Context Engine" pedido). Responsável por montar, sob demanda, um objeto compacto com a estrutura da empresa (empresa, contas de marketplace/lojas, indicadores essenciais, regras declaradas ativas) — nunca o banco inteiro.
- **`server/lib/mapaProdutos.js`** (fora de `lib/ia/`, porque não é exclusivo da IA — uma futura tela de cadastro de produto físico usaria o mesmo módulo): estende o que já existe em `produtos_base`/`produto_base_skus`/`resolverProdutosBasePorSku` com medida, categoria, aliases, e uma função de resolução em linguagem natural.
- **`server/lib/ia/regrasNegocio.js`** — CRUD da tabela nova de regras/preferências declaradas, sempre com confirmação explícita antes de persistir (nunca escrita silenciosa a partir de uma frase solta).
- **`server/lib/tarefas.js`** (fora de `lib/ia/` — tarefa é um conceito do ERP, não só da IA) + **`server/lib/notificacoes.js`** (canal de envio, WhatsApp incluso) — para o ciclo alerta→tarefa→lembrete→WhatsApp.

`baseConhecimento.js` (textos estáticos de documentação) e `estrutura.js` (cards visuais) continuam existindo exatamente como estão — não são substituídos, são complementados.

### 2.3 Conhecimento estável × dados dinâmicos — onde cada coisa mora

| Tipo | Exemplos | Onde mora | Atualização |
|---|---|---|---|
| **Estável, estruturado** | mapa produto físico↔SKU, medida, categoria, aliases | `produtos_base` (+campos novos), `produto_base_skus`, nova tabela `produto_base_aliases` | Editado manualmente (nova tela) ou sugerido automaticamente e confirmado |
| **Estável, declarado pelo usuário** | "margem mínima ideal 15%", "manter 7 dias de estoque no Full" | nova tabela `regras_negocio_ia` | Só grava depois de confirmação explícita — nunca automático |
| **Dinâmico** | faturamento, estoque, saldo, contas, Ads, preço | tabelas já existentes, sempre consultadas na hora | Nunca cacheado pela camada de contexto — cada pergunta financeira/operacional dispara uma ferramenta real, exatamente como já funciona hoje |

Isso responde diretamente ao ponto 3 do pedido: a camada nova **não guarda dado dinâmico**, ela só sabe *onde* e *como* buscar — o dado em si sempre vem fresco.

### 2.4 Mapa de produtos — o que muda de verdade

O núcleo (SKU → produto físico → multiplicador) já existe e está bem desenhado (item 1.1) — a proposta não reconstrói isso, **estende**:

1. **`produtos_base` ganha 2 colunas novas:** `medida` (texto, ex: "16X11X6" — hoje só embutida no `codigo`) e `categoria` (texto livre com sugestões, mesmo padrão já usado em `contas_pagar.categoria`/`despesas_fixas.categoria`).
2. **Tabela nova `produto_base_aliases`:** `id, empresa_id, produto_base_id, alias (texto), origem ('manual'|'ia_sugerido'), created_at`. Guarda como o usuário costuma chamar o produto ("caixa pequena", "aquela 16x11x6"). `ia_sugerido` significa que a própria IA percebeu um padrão de referência numa conversa e está sugerindo salvar — **sempre com confirmação do usuário antes de gravar** (mesma disciplina do resto do projeto).
3. **Tela nova (ou aproveitar a API já pronta) para gerenciar `produtos_base`/`produto_base_skus`/aliases** — hoje é 100% API sem UI (gap crítico já registrado no item 1.1). Sem essa tela, tanto o usuário quanto a IA ficam dependendo de vínculo automático via regex, que já é bom mas não cobre tudo.
4. **Ferramenta nova para a IA: `identificar_produto_fisico`** — recebe um texto livre ("16x11x6", "cx 50 da 16x11x6") e devolve: match exato por `codigo`/alias → produto físico certo; múltiplos candidatos plausíveis → lista pra IA perguntar qual (nunca chuta); nenhum candidato → resposta clara de "não encontrei nenhum produto com esse nome/medida cadastrado". Todo o resto das ferramentas que hoje recebem `produtoBase` como filtro de texto (ex: `estoque_fisico_detalhado`) passam a poder receber o resultado desta ferramenta.

### 2.5 Regras de negócio / memória empresarial controlada

Nova tabela `regras_negocio_ia`: `id, empresa_id, chave (texto curto, ex: 'margem_minima_ideal'), valor (JSONB), descricao (texto — a frase original do usuário), origem ('usuario_confirmado'), criado_em, atualizado_em, ativo`.

**Fluxo, respeitando a regra do pedido ("nunca transformar frase casual em regra permanente sem critério"):**
1. Usuário diz algo que soa como uma regra durável ("nossa margem mínima ideal é 15%").
2. A IA **nunca grava direto**. Ela responde confirmando o que entendeu e pergunta se deve salvar como regra da empresa (ex: "Entendi — quer que eu passe a usar 15% como sua margem mínima ideal nas próximas análises?").
3. Só quando o usuário confirma explicitamente ("sim"/"confirma"/clica um botão), uma ferramenta de escrita **estreita e específica** (`definir_regra_negocio`, únca exceção deliberada ao "somente leitura" das outras 24 ferramentas) grava a linha — e a resposta da IA sempre confirma o que foi salvo, nunca silenciosamente.
4. Essa regra passa a ser lida (não pela IA "lembrando" da conversa — pela ferramenta `contexto_negocio`/qualquer ferramenta relevante consultando `regras_negocio_ia` no banco) em conversas futuras, inclusive por outro dispositivo/sessão.
5. Editar/desativar uma regra segue o mesmo padrão de confirmação.

Esta é a única gravação nova que a IA ganha nesta proposta — todo o resto continua **estritamente somente leitura**, do jeito que o projeto já garante hoje (nenhuma ferramenta grava dado financeiro/operacional). Se preferir remover mesmo essa exceção, dá pra fazer só por um botão na tela (nunca por texto de chat) — decisão seguinte é sua.

### 2.6 Contexto da conversa (resolver "isso", "dela")

Não requer uma tabela nova — é, na maior parte, um ajuste de prompt/orquestração:

1. **Aumentar moderadamente a janela de histórico** (hoje 8 mensagens/2000 caracteres) só o suficiente para cobrir 2-3 trocas de acompanhamento sem inflar custo — a decidir com teste real.
2. **Rastrear a "última entidade resolvida" na própria requisição/sessão do chat** (não precisa persistir no banco): toda vez que uma ferramenta resolve um produto físico específico (via `identificar_produto_fisico` ou outra), o orquestrador guarda esse resultado num rodapé curto do próprio histórico da conversa (ex: uma linha de sistema "Produto em foco: CAIXA 16X11X6 (produtoBaseId=12)"), que o modelo pode reaproveitar na pergunta seguinte sem precisar adivinhar do texto cru. Isso é mais confiável do que só confiar no modelo reler o texto anterior.
3. O modelo (Claude) já é competente em resolução de referência dentro de uma janela curta de histórico — o ajuste acima é reforço, não substituição da capacidade nativa do modelo.

### 2.7 "Raio-X da empresa" — compor, não recriar

Como já registrado (1.5), `lib/visaoGeralPainel.js#painelVisaoGeral` já é 80% disso. Proposta: uma função nova em `contextoNegocio.js`, `montarRaioXEmpresa(empresaId, periodoChave)`, que **chama** (nunca duplica) `painelVisaoGeral`, `resumoRecebimentosMarketplace`, `gerarFluxoDeCaixa`, `radar_alertas` abertos e `regras_negocio_ia` ativas, e devolve tudo já organizado num objeto único. Vira uma ferramenta nova pra IA (`visao_geral_empresa` ou nome parecido) para perguntas amplas como "Como está minha empresa hoje?"/"Tem algo urgente?".

### 2.8 Fonte de cada informação / conflito nunca escondido

Proposta simples e barata: um mapa estático `ORIGENS_DADOS` (mesmo padrão de `baseConhecimento.js`) documentando de onde cada indicador vem (ex: `faturamento: 'ml_pedidos + ml_pedido_itens, via relatorioVendas.js'`) — usado tanto na base de conhecimento consultável quanto como instrução fixa no system prompt: **quando duas ferramentas divergirem num mesmo número, a IA deve dizer isso explicitamente, nunca escolher uma calada.** Isso é principalmente uma regra de prompt (fácil e barata), reforçada por essa documentação central.

### 2.9 Atualização contínua — sem cache que envelhece

A camada de contexto **não introduz nenhum job de sincronização novo**. Ela lê:
- `produtos_base`/`produto_base_skus`/aliases: dado estável, editado por ação explícita (tela nova ou confirmação da IA) — sempre atual por definição.
- `regras_negocio_ia`: mesma lógica.
- Tudo dinâmico: consulta direta às tabelas já mantidas atualizadas pelos ciclos existentes (`syncScheduler`, `radarScheduler`, materialização em leitura de `recebimentosMl`/`fluxoCaixa`) — a camada de contexto nunca guarda um snapshot financeiro em cache que possa ficar desatualizado.

### 2.10 Não jogar o banco inteiro no prompt

O `system prompt` ganha, no máximo, um bloco curto e limitado (proposta: sob ~1.500 tokens) com a "ficha da empresa": nome, contas de marketplace conectadas/lojas, quantidade de produtos físicos cadastrados, regras de negócio ativas (as declaradas, não recalculadas). **Nada de tabela, nada de lista de pedidos, nada de estoque item a item** — isso continua 100% dentro de ferramentas, chamadas sob demanda, exatamente como já funciona. A camada de contexto existe para a IA saber **que ferramenta chamar e com qual parâmetro**, não para substituir as ferramentas.

### 2.11 IA proativa — alerta → tarefa → lembrete → WhatsApp

Esta é a parte que exige mais decisão do usuário antes de seguir, porque envolve uma integração externa nova.

1. **Tabela nova `tarefas`:** `id, empresa_id, origem ('radar_alerta'|'manual'|'ia_sugerida'), radar_alerta_id (FK nullable), titulo, descricao, prazo (data/hora, opcional), status ('pendente'|'concluida'|'cancelada'), criado_em, concluido_em`.
2. **Fluxo:** quando o Radar (já existente) detecta algo com severidade alta (ex: `estoque_cobertura_critica`), a tela/IA oferece **"Criar tarefa a partir deste alerta"** — nunca cria sozinha sem esse clique/confirmação, seguindo a mesma disciplina de conciliação bancária/regras de negócio. Depois de aprovado o MVP, dá pra decidir junto com você quais categorias de alerta podem virar tarefa automaticamente (opt-in, nunca por padrão).
3. **Lembrete:** campo `prazo` na tarefa + um scheduler novo (mesmo padrão de `syncScheduler`/`radarScheduler`) que verifica tarefas vencendo e dispara notificação.
4. **WhatsApp: requer uma integração externa real** (API oficial do WhatsApp Business/Meta Cloud API, ou um provedor como Twilio/Z-API) — isso significa **credenciais que só você pode gerar/fornecer** (número de telefone comercial, token de API). Não é algo que dá pra "ligar" só com código — é uma decisão e um cadastro fora do ERP que precisa vir de você. Recomendo tratar isso como uma etapa própria, depois que o resto estiver aprovado e funcionando, exatamente pelo mesmo motivo que a IA_API_KEY é uma pendência sua hoje.

---

## PARTE 3 — RESPOSTAS ÀS 10 PERGUNTAS FINAIS

**1. O que a IA já consegue saber sobre sua empresa hoje** — praticamente tudo que já é uma tela do ERP: vendas/margem/pedidos com prejuízo, produtos por SKU e por caixa física, estoque (resumo, valor físico a custo, detalhado por produto), contas a pagar/receber, recebimentos de marketplace com os 3 status corretos, os 2 fluxos de caixa (incluindo saldo real quando você informa saldo inicial) e extrato bancário importado, DRE completa, compras por fornecedor, notas fiscais, comparação com período anterior, projeção até fim do mês, e os alertas do Radar — sempre com o número batendo exatamente com a tela, porque todas as 25 ferramentas leem as mesmas funções que alimentam as telas.

**2. O que existe no banco mas ela ainda não consulta** — nada de relevante ficou fora: as 25 ferramentas cobrem essencialmente toda tabela financeira/operacional já madura do projeto. As lacunas reais não são "dado existente sem ferramenta" — são dado que **não existe ainda** (ver pergunta 3).

**3. O que ainda não está estruturado** — medida/categoria/alias de produto; histórico de custo; devolução; metas; despesas variáveis; giro de estoque como ferramenta (cobertura já existe, só dentro do Radar); ponto de reposição configurável; regra de negócio declarada pelo usuário; tarefas/lembretes; qualquer integração de notificação (WhatsApp).

**4. Quais ferramentas novas** — nesta primeira leva: `identificar_produto_fisico` (linguagem natural → produto), `visao_geral_empresa`/raio-X (composição do que já existe), `definir_regra_negocio` (única com escrita, sempre com confirmação), e uma consulta de regras ativas (`regras_negocio_ativas`). Cobertura de estoque e giro podem virar ferramentas próprias reaproveitando `radarNegocio.js`, se você confirmar que quer isso exposto fora do Radar.

**5. Como será construída a camada de conhecimento empresarial** — `server/lib/ia/contextoNegocio.js`, que nunca duplica dado: monta um "perfil" compacto (estrutura da empresa + regras ativas) para o rodapé do system prompt, e uma função de raio-X que **compõe** funções já existentes (`painelVisaoGeral` à frente). Dado dinâmico nunca fica cacheado nela.

**6. Como manter esse conhecimento atualizado** — o estável (mapa de produtos, regras) é atualizado por ação explícita (tela nova, ou confirmação da IA); o dinâmico nunca é armazenado por essa camada — cada pergunta financeira/operacional dispara a mesma consulta real de sempre, então está sempre atual por construção, sem precisar de um job de "refresh" novo.

**7. Como funcionará o contexto entre mensagens** — janela de histórico da conversa (já existe, pode crescer um pouco) + um rodapé curto rastreando a última entidade (produto) resolvida na conversa, pra não depender só do modelo reler texto cru.

**8. Como funcionará a memória empresarial** — só regras que o usuário confirmou explicitamente, numa tabela própria (`regras_negocio_ia`), nunca uma frase solta virando regra permanente sozinha. É uma memória pequena, auditável (guarda a frase original) e editável.

**9. Como garantir que dados atuais sejam sempre consultados** — arquitetural, não um lembrete de prompt: a camada de contexto **fisicamente não tem onde guardar** um valor financeiro/operacional — só tabelas de estrutura (produto, regra). Qualquer pergunta sobre um número de verdade só pode ser respondida chamando uma das 25+ ferramentas, que sempre consultam o banco na hora — exatamente a garantia que já existe hoje, preservada.

**10. Como integrar com estoque, tarefas, alertas e WhatsApp** — estoque/alertas já estão integrados (Radar). Tarefas são uma tabela nova simples, ligada opcionalmente a um alerta do Radar, sempre criada por ação explícita no início. WhatsApp é a única peça que depende de uma decisão e um cadastro externo seus (provedor + credencial) — proposta é tratar como uma etapa separada, depois que o resto estiver rodando.

---

## O que precisa da sua decisão antes de eu implementar qualquer coisa

1. **Nome da camada** (`contextoNegocio.js` e os outros nomes propostos) — ok, ou prefere outro?
2. **Tela de gestão de produto físico/SKU/alias** — vale a pena priorizar agora (é um gap real e trava a resolução por linguagem natural), ou fica para depois?
3. **A única exceção de escrita da IA** (`definir_regra_negocio`, sempre com confirmação) — aprova esse desenho, ou prefere que regras só sejam criadas por um botão na tela, nunca por texto de chat?
4. **Escopo desta primeira etapa** — sugiro dividir em passos pequenos e testáveis, no mesmo estilo das entregas anteriores: (a) mapa de produtos + alias + tela; (b) camada de contexto + raio-X + ferramenta de identificação de produto; (c) regras de negócio; (d) tarefas ligadas ao Radar; (e) WhatsApp, só depois de você decidir o provedor. Concorda com essa ordem, ou prefere outra?
5. **WhatsApp** — qual provedor você já usa ou prefere (API oficial da Meta, Twilio, Z-API, outro)? Isso muda o desenho técnico da etapa (e).

Sem essas respostas eu não começo a escrever nenhuma linha de código — só volto quando você aprovar o desenho e a ordem.
