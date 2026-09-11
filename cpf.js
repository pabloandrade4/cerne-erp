// Validação de CPF (dígitos verificadores, algoritmo padrão da Receita
// Federal). Usada em Fornecedores quando o documento informado tem 11
// dígitos (pessoa física) — para 14 dígitos (pessoa jurídica) a tela usa a
// validação de CNPJ já existente em lib/cnpj.js. Regra técnica de formato —
// não é uma regra de negócio do ERP, por isso não está em
// docs/01-regras-de-negocio.md.

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidCPF(raw) {
  const cpf = onlyDigits(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // todos os dígitos iguais

  const calcDigit = (base) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) {
      sum += Number(base[i]) * (base.length + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  const base9 = cpf.slice(0, 9);
  const d1 = calcDigit(base9);
  const d2 = calcDigit(base9 + d1);

  return cpf === base9 + String(d1) + String(d2);
}

function formatCPF(raw) {
  const cpf = onlyDigits(raw);
  if (cpf.length !== 11) return raw;
  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

module.exports = { onlyDigits, isValidCPF, formatCPF };
