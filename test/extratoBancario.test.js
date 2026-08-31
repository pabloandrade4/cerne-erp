const { test } = require('node:test');
const assert = require('node:assert/strict');
const extrato = require('../lib/extratoBancario');

test('normaliza valores brasileiros com sinal', () => {
  assert.equal(typeof extrato.normalizarValor, 'function');
  assert.equal(extrato.normalizarValor('R$ 32.144,56'), 32144.56);
  assert.equal(extrato.normalizarValor('-131.639,08'), -131639.08);
  assert.equal(extrato.normalizarValor('+10.696,00'), 10696);
});

test('lê CSV Nubank realista e classifica entrada/saída', () => {
  assert.equal(typeof extrato.lerCsvBuffer, 'function');
  const csv = Buffer.from('Data;Natureza;Tipo;Descrição;Valor (R$)\n11/08/2026;Saída;Pagamento de boleto efetuado;CONTADOR;-680,0\n17/08/2026;Entrada;Transferência recebida pelo Pix;PF EMBALAGENS;11098,0\n');
  const r = extrato.lerCsvBuffer(csv);
  assert.equal(r.movimentos.length, 2);
  assert.deepEqual(r.movimentos[0], { data:'2026-08-11', tipo:'saida', descricao:'CONTADOR', valor:680 });
  assert.deepEqual(r.movimentos[1], { data:'2026-08-17', tipo:'entrada', descricao:'PF EMBALAGENS', valor:11098 });
});

test('CSV detecta saldo final quando existe coluna de saldo', () => {
  const csv = Buffer.from('Data;Descrição;Valor;Saldo\n30/08/2026;PIX A;-100,00;1.500,00\n31/08/2026;PIX B;200,00;1.700,00\n');
  const r = extrato.lerCsvBuffer(csv);
  assert.equal(r.saldoFinal, 1700);
  assert.equal(r.saldoData, '2026-08-31');
});

test('texto de PDF Nubank detecta saldo final, data final e conta', () => {
  assert.equal(typeof extrato.analisarTextoPdfNubank, 'function');
  const texto = `EMPRESA TESTE LTDA\nCNPJ 00.000.000/0001-00 Agência 0001 Conta\n123456789-0\n01 DE AGOSTO DE 2026 a 27 DE AGOSTO DE 2026 VALORES EM R$\nSaldo final do período\nR$ 12.345,67\nSaldo inicial 10.000,00\nTotal de entradas +3.000,00\nTotal de saídas -654,33\nSaldo final do período 12.345,67\nMovimentações\n03 AGO 2026 Total de saídas - 1.266,50\nTransferência enviada pelo Pix JULIANO TESTE 606,50\nTransferência enviada pelo Pix AMANDA TESTE 660,00\nSaldo do dia 28.169,72\n06 AGO 2026 Total de entradas + 10.696,00\nTransferência recebida pelo Pix EMPRESA TESTE LTDA 10.696,00\nSaldo do dia 38.865,72`;
  const r = extrato.analisarTextoPdfNubank(texto);
  assert.equal(r.banco, 'Nubank');
  assert.equal(r.conta, '123456789-0');
  assert.equal(r.saldoFinal, 12345.67);
  assert.equal(r.saldoData, '2026-08-27');
  assert.equal(r.movimentos.length, 3);
  assert.equal(r.movimentos[0].tipo, 'saida');
  assert.equal(r.movimentos[2].tipo, 'entrada');
});

test('fingerprint diferencia ocorrências idênticas sem perder deduplicação entre reimportações', () => {
  assert.equal(typeof extrato.adicionarFingerprints, 'function');
  const movs = [
    { data:'2026-08-31', tipo:'saida', descricao:'PIX TESTE', valor:50 },
    { data:'2026-08-31', tipo:'saida', descricao:'PIX TESTE', valor:50 },
  ];
  const a = extrato.adicionarFingerprints(movs);
  const b = extrato.adicionarFingerprints(movs);
  assert.notEqual(a[0].fingerprint, a[1].fingerprint);
  assert.equal(a[0].fingerprint, b[0].fingerprint);
  assert.equal(a[1].fingerprint, b[1].fingerprint);
});

test('analisarArquivo usa PDF textual e devolve hash/fingerprints', async () => {
  assert.equal(typeof extrato.analisarArquivo, 'function');
  const fakePdf = async () => ({ text:`EMPRESA TESTE LTDA\nNu Pagamentos S.A.\nAgência 0001 Conta\n123456789-0\n01 DE AGOSTO DE 2026 a 31 DE AGOSTO DE 2026\nSaldo final do período\nR$ 1.234,56\n31 AGO 2026 Total de entradas + 100,00\nTransferência recebida pelo Pix TESTE 100,00\nSaldo do dia 1.234,56` });
  const r = await extrato.analisarArquivo({nomeArquivo:'nubank.pdf',buffer:Buffer.from('pdffake')},{pdfParse:fakePdf});
  assert.equal(r.formato,'pdf');
  assert.equal(r.saldoFinal,1234.56);
  assert.equal(r.saldoData,'2026-08-31');
  assert.equal(r.movimentos.length,1);
  assert.equal(r.movimentos[0].fingerprint.length,64);
  assert.equal(r.arquivoHash.length,64);
});

test('PDF de outro banco não é tratado silenciosamente como Nubank', async () => {
  const fakePdf = async () => ({ text:`BANCO EXEMPLO S.A.\nAgência 0001 Conta\n12345678-9\n01 DE AGOSTO DE 2026 a 31 DE AGOSTO DE 2026\nSaldo final do período\nR$ 999,99\n31 AGO 2026 Total de entradas + 100,00\nTransferência recebida TESTE 100,00\nSaldo do dia 999,99` });
  await assert.rejects(
    () => extrato.analisarArquivo({nomeArquivo:'outro-banco.pdf',buffer:Buffer.from('pdffake')},{pdfParse:fakePdf}),
    /PDF.*Nubank/i
  );
});

test('não anuncia suporte ao XLS legado que o ExcelJS não lê', async () => {
  await assert.rejects(
    () => extrato.analisarArquivo({nomeArquivo:'extrato.xls',buffer:Buffer.from('xls-legado')}),
    /Formato não suportado.*XLSX/i
  );
});
