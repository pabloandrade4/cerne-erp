// Validação de CNPJ (dígitos verificadores, algoritmo padrão da Receita
// Federal). Regra técnica de formato — não é uma regra de negócio do ERP,
// por isso não está em docs/01-regras-de-negocio.md.

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidCNPJ(raw) {
  const cnpj = onlyDigits(raw);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false; // todos os dígitos iguais

  const calcDigit = (base) => {
    const weights = base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = base
      .split('')
      .reduce((acc, digit, i) => acc + Number(digit) * weights[i], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const base12 = cnpj.slice(0, 12);
  const d1 = calcDigit(base12);
  const d2 = calcDigit(base12 + d1);

  return cnpj === base12 + String(d1) + String(d2);
}

function formatCNPJ(raw) {
  const cnpj = onlyDigits(raw);
  if (cnpj.length !== 14) return raw;
  return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

module.exports = { onlyDigits, isValidCNPJ, formatCNPJ };
