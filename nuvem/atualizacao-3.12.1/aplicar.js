#!/usr/bin/env node
// MesaPronta 3.12.1 (só o programa do computador): abrir o sistema sem a janela preta (cmd).
// Troca o manifesto da atualização automática para o .exe 3.12.1, depois de conferir o SHA do arquivo publicado.
// Uso: node aplicar.js <commit-do-github>
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), cp = require('child_process');
const MANIFESTO = process.env.PRONTA_MANIFESTO || '/srv/pronta/dados/atualizacao.json';
const VERSAO = '3.12.1';
const EXE = { nome: `MesaPronta-${VERSAO}.exe.gz`, sha256: 'b147b1d72271b9adf2fd48ddffa0e94def3dfe4e603d70662ede7441b92b6bd8', bytes: 96182272 };
const COMMIT = String(process.argv[2] || '');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const parar = (m) => { console.log('\n*** ' + m + '\n*** NADA FOI MUDADO.'); process.exit(1); };
if (!/^[0-9a-f]{40}$/.test(COMMIT)) parar('passe o commit completo do mesapronta-status.');
const antes = fs.readFileSync(MANIFESTO, 'utf8'), raiz = JSON.parse(antes);
const m = raiz.restaurante && typeof raiz.restaurante === 'object' ? raiz.restaurante : raiz;
console.log('manifesto antes:', JSON.stringify(m));
if (!m.versao || !m.url || !m.sha256) parar('o manifesto não tem versao/url/sha256.');
const url = `https://raw.githubusercontent.com/gabriel-rod7/mesapronta-status/${COMMIT}/download/${EXE.nome}`;
const tmp = path.join(os.tmpdir(), EXE.nome);
cp.execSync(`curl -fsSL -o ${JSON.stringify(tmp)} ${url}`);
const exe = cp.execSync(`gunzip -c ${JSON.stringify(tmp)}`, { maxBuffer: 300 * 1024 * 1024 }); fs.rmSync(tmp, { force: true });
if (sha(exe) !== EXE.sha256 || exe.length !== EXE.bytes) parar(`o .exe do GitHub não confere (sha ${sha(exe).slice(0, 16)}, ${exe.length} bytes).`);
fs.copyFileSync(MANIFESTO, MANIFESTO + '.antes-' + VERSAO);
m.versao = VERSAO; m.url = url; m.sha256 = EXE.sha256; if ('tamanho' in m || true) m.tamanho = EXE.bytes;
fs.writeFileSync(MANIFESTO, JSON.stringify(raiz));
console.log('manifesto agora:', JSON.stringify(m));
console.log(`\nPRONTO: os computadores recebem a ${VERSAO} sozinhos. Para voltar: cp ${MANIFESTO}.antes-${VERSAO} ${MANIFESTO}`);
