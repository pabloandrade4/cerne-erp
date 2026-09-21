// Especialista "SAC Shopee" para a Daily dos Agentes (20/09/2026, pedido
// explícito do usuário). Wrapper fino sobre especialistaSacComum.js — ver
// aquele arquivo pra lógica de classificação/consulta real.
const { criarEspecialistaSac } = require('./especialistaSacComum');

module.exports = criarEspecialistaSac({ agenteCodigo: 'sac_shopee', marketplace: 'shopee' });
