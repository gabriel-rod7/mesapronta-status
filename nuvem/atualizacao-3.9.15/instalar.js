'use strict';
// MesaPronta 3.9.15 no servidor — tudo junto, numa vez só:
//   parte 1 (aplicar.js): logo/banner no cardápio, pratos por dia, escolha obrigatória (sabor), ler o QR da mesa
//   parte 2 (aplicar-cpf.js + unicos.js): um CPF/CNPJ por conta e aviso de WhatsApp já cadastrado
// Uso: node instalar.js <commit> --com-programa     (o mesmo da parte 1; --ensaio só ensaia a parte 1)
// Cada parte confere tudo, faz backup e volta sozinha se o servidor não subir. Se a parte 1 parar, a parte 2 não roda.
const cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2);
const rodar = (arq, a) => cp.spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, arq), ...a], { stdio: 'inherit' }).status;
console.log('==== MesaPronta 3.9.15 — parte 1 de 2: cardápio (logo, dias, sabor, QR da mesa) ====');
if (rodar('aplicar.js', args) !== 0) { console.log('\n*** A parte 1 parou. A parte 2 (CPF) não foi aplicada. Mande esta tela para o Claude.'); process.exit(1); }
if (args.includes('--ensaio')) { console.log('\n(ensaio: a parte 2 não roda em ensaio)'); process.exit(0); }
console.log('\n==== MesaPronta 3.9.15 — parte 2 de 2: um CPF/CNPJ por conta e aviso de WhatsApp ====');
const st = rodar('aplicar-cpf.js', []);
console.log(st === 0 ? '\n==== 3.9.15 COMPLETA no servidor (partes 1 e 2). ====' : '\n*** A parte 1 ficou aplicada, a parte 2 parou. Mande esta tela para o Claude.');
process.exit(st);
