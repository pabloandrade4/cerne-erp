# Problemas Conhecidos

Lista de problemas, limitações ou pendências identificadas durante o
desenvolvimento, para não serem esquecidas.

## `git push` direto não funciona nesta sessão do Cowork
- O usuário pediu para o Claude trabalhar direto no repositório Git
  (editar → testar → commit → push). `git clone` funciona (leitura
  liberada), mas `git push` é bloqueado pelo proxy de git desta sessão:
  *"pabloandrade4/cerne-erp is not in this session's authorized repository
  set... To fix, add the repository to the session's sources."*
- Não existe, neste ambiente (Cowork), nenhum comando disponível para
  autorizar isso a partir do chat (diferente do Claude Code CLI, que tem
  esse mecanismo). Parece ser uma configuração do lado do produto Cowork,
  fora do alcance desta sessão.
- **Enquanto isso não for resolvido:** o Claude edita e testa os arquivos
  normalmente, empacota um `.zip` só com o que mudou, e o usuário sobrescreve
  os arquivos no GitHub manualmente (Add file → Upload files) e comita.

## Sincronização do Mercado Livre pode ficar lenta com muitos pedidos
- Testado com a conta real "PFEMBALAGEMS": sincronizar ~193 pedidos dos
  últimos 30 dias levou vários minutos. A sincronização processa um pedido
  por vez (sequencial), com até 3 chamadas à API do Mercado Livre por
  pedido — sob volume alto, parece esbarrar em rate-limiting real da API do
  Mercado Livre, deixando o processo bem mais lento (não trava mais
  indefinidamente, pois foi adicionado um timeout de 20s por chamada, mas
  ainda pode demorar bastante para terminar).
- Não foi otimizado agora (ex: processar pedidos em paralelo com limite de
  concorrência, ou pausar/repetir com backoff quando a API sinalizar limite
  de uso) porque estava fora do escopo dos 3 passos pedidos nesta etapa.
  Ver `06-proximos-passos.md`.

## `mcp__Render__query_render_postgres` não funciona
- A ferramenta de consulta direta ao Postgres do Render (via MCP) retorna
  erro de SSL (`FATAL: SSL/TLS required`) mesmo em consultas simples de
  leitura. Não foi possível inspecionar o banco de produção diretamente por
  esse caminho — os testes usaram as próprias rotas da API (`/api/...`) e um
  Postgres local só para validar a sintaxe das queries antes de publicar.
- Os logs de request (HTTP) do serviço no Render também não retornaram nada
  via `mcp__Render__list_logs` (só os logs de build/boot aparecem) — não dá
  para usar esse caminho para depurar tráfego HTTP em tempo real.

## Banco Postgres do Render está no plano gratuito (expira em 30 dias)
- O banco `cerne-db` foi criado no plano **Free** do Render, que **expira em
  20/09/2026**. Depois disso o Render pode apagar o banco se não for
  migrado para um plano pago antes.
- Ação necessária: antes dessa data, decidir com o usuário se migra para um
  plano pago do Postgres no Render (para não perder os dados das empresas
  cadastradas e dos próximos módulos).

## Serviço web também está no plano gratuito do Render
- O serviço `cerne-erp` está no plano **Free**. Nesse plano o Render
  "dorme" o serviço após um período sem acessos, e a primeira requisição
  depois disso demora mais (cold start, alguns segundos). Não afeta os
  dados, só a velocidade de resposta na primeira visita. Se isso incomodar,
  dá pra migrar para um plano pago mais adiante.

## Existe um registro de teste na tabela de Empresas
- Durante o teste do CRUD na URL pública, foi cadastrada uma empresa de
  teste ("Empresa Teste Cerne LTDA (editada)", CNPJ 11.222.333/0001-81) para
  validar cadastro/edição/ativação. Ela foi deixada **desativada** no final
  dos testes. Como ainda não existe exclusão definitiva (só
  ativar/desativar — ver `01-regras-de-negocio.md`), ela continua no banco.
  O usuário pode ignorá-la ou pedir para removê-la quando a exclusão
  definitiva for implementada.

## Este ambiente de desenvolvimento não consegue instalar pacotes npm
- O sandbox onde o Claude desenvolve não tem acesso aos registros do
  `npm`/`pip` (bloqueio de rede). Isso não afeta o site publicado (o Render
  builda o projeto na infraestrutura dele, com internet completa), mas
  significa que o Claude não consegue rodar `npm install` nem testar o
  servidor Express localmente neste ambiente — os testes de código
  precisam ser feitos de outras formas (ex: testar a lógica isolada, testar
  o SQL direto no Postgres, ou testar direto na URL publicada).
