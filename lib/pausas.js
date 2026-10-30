// Chave liga/desliga dos agentes e rotinas automáticas — 30/10/2026, pedido
// explícito do usuário (Fase 1 "Cerne só financeiro"): pausar os agentes
// próprios do Cerne SEM apagar código nem histórico; os agentes do JARVIS
// entram no lugar deles. Padrão: TUDO PAUSADO. Para religar, no Render
// (Environment) crie a variável CERNE_ATIVAR com os nomes separados por
// vírgula, ou "todos". Exemplo: CERNE_ATIVAR=envio_full,devolucoes
// Nomes ainda existentes: devolucoes, ads_ml. (Radar, promoções, SAC, daily,
// concorrente, compras IA, envio Full e Ads Shopee foram ARQUIVADOS em
// _arquivo/ em 30/10/2026 — ver _arquivo/LEIA-ME.md.)
// Nunca controla: pedidos ML/Shopee, token Shopee e despesas fixas (o
// financeiro depende deles).
function ativados() {
  return String(process.env.CERNE_ATIVAR || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function rotinaAtiva(nome) {
  const lista = ativados();
  return lista.includes('todos') || lista.includes(String(nome).toLowerCase());
}
// Roda iniciar() só se a rotina estiver ligada; senão registra no log.
function iniciarSePermitido(nome, iniciar) {
  if (rotinaAtiva(nome)) return iniciar();
  console.log(`[pausas] rotina "${nome}" PAUSADA (para religar: CERNE_ATIVAR=${nome} no Render).`);
  return undefined;
}
module.exports = { rotinaAtiva, iniciarSePermitido };
