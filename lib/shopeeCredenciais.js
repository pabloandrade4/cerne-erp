// Helper único para ler as credenciais da Shopee (SHOPEE_PARTNER_ID,
// SHOPEE_PARTNER_KEY, SHOPEE_TOKEN_KEY) das variáveis de ambiente, sempre
// removendo espaço/quebra de linha sobrando nas pontas.
//
// Por quê: em 14/09/2026 descobrimos que a SHOPEE_PARTNER_KEY salva no
// Render tinha 1 quebra de linha sobrando no final — um acidente de
// copiar/colar do próprio painel da Shopee. Sem aparar a chave, a
// assinatura HMAC de QUALQUER chamada à API da Shopee fica errada ("Wrong
// sign."/error_sign), mesmo a chave "parecendo" certa (o valor visível é
// idêntico ao do painel da Shopee — só o caractere invisível no final é
// diferente).
//
// A correção original (mesmo dia) só trocou os pontos de uso dentro de
// routes/shopee.js (conectar/callback). Poucos minutos depois, o MESMO bug
// reapareceu em dois lugares que liam `process.env.SHOPEE_PARTNER_*`
// direto, sem passar por esse trim: a sincronização de pedidos
// (lib/shopeeSync.js) e a renovação automática de token
// (lib/shopeeTokenScheduler.js) — por isso a primeira sincronização real
// falhou nas 4 janelas com "Wrong sign.", mesmo a conexão já estando ativa.
//
// Centralizando aqui: daqui pra frente, QUALQUER lugar que precisar de uma
// credencial da Shopee usa esta função, nunca `process.env` direto — assim
// esse bug específico não pode voltar uma terceira vez.
function credencialShopee(nome) {
  const v = process.env[nome];
  return typeof v === 'string' ? v.trim() : v;
}

module.exports = { credencialShopee };
