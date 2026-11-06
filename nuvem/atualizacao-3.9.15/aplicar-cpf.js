#!/usr/bin/env node
// MesaPronta 3.9.15 (parte 2) no servidor: um CPF/CNPJ por conta + aviso de WhatsApp já cadastrado.
// Uso (no servidor, como root): node aplicar.js
// Só mexe no servidor (orquestrador): coloca nuvem/unicos.js e um gancho no começo de rotasApp().
// Se algo não bater, para antes de mexer. Se o servidor não voltar, volta sozinho para a versão anterior.
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), http = require('http');
const E = process.env; // (P314_* só para o teste local)
const AQUI = __dirname, APP = E.P314_APP || '/srv/pronta/app', ATUAL = APP + '/familia', NOVO = APP + '/familia.novo', ANTIGO = APP + '/familia.antigo';
const DADOS = E.P314_DADOS || '/srv/pronta/dados', BACKUPS = E.P314_BACKUPS || '/srv/pronta/backups', PORTA = Number(E.P314_PORTA || 8080);
const REINICIAR = E.P314_REINICIAR || 'systemctl restart pronta-nuvem', DONO = E.P314_SEM_CHOWN ? 'true' : 'chown -R pronta:pronta';
const DOMINIO = E.P314_DOMINIO || 'mesapronta.net';
const ANCORA = "async function rotasApp(req, res, dominio, url) {\n  const produto = CFG.dominios[dominio] || 'restaurante';\n";
const GANCHO = "  { const u = await (globalThis.__cpfUnico || (globalThis.__cpfUnico = require('./unicos')({ db, CFG }))).antes(req, res, dominio, url, produto); if (u === true) return; if (u) req = u; }   // 3.9.14: um CPF/CNPJ por conta, aviso de WhatsApp (unicos.js)\n";
const sh = (c) => cp.execSync(c, { stdio: 'pipe' }).toString().trim();
const espera = (ms) => new Promise(r => setTimeout(r, ms));
function sair(msg) { console.log('\n*** ' + msg + '\n*** NADA FOI MUDADO NO SERVIDOR.'); process.exit(1); }
function pedir(host, caminho, metodo = 'GET', corpo = null) {
  return new Promise((ok) => {
    const h = { Host: host }; if (corpo) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(corpo); }
    const r = http.request({ host: '127.0.0.1', port: PORTA, path: caminho, method: metodo, headers: h, timeout: 8000 }, (x) => { let s = ''; x.on('data', d => s += d); x.on('end', () => ok({ status: x.statusCode, corpo: s })); });
    r.on('error', (e) => ok({ status: 'erro: ' + e.message })); r.on('timeout', () => { r.destroy(); ok({ status: 'sem resposta' }); });
    if (corpo) r.write(corpo); r.end();
  });
}
async function saudavel() { for (let i = 0; i < 20; i++) { await espera(1000); const r = await pedir('app.' + DOMINIO, '/__saude'); if (r.status === 200) return true; } return false; }

(async () => {
  console.log('== MesaPronta 3.9.15 parte 2 (um CPF/CNPJ por conta, aviso de WhatsApp) — servidor ==');
  if (!fs.existsSync(ATUAL + '/nuvem/orquestrador.js')) sair('Não achei ' + ATUAL);
  console.log('No ar agora: ' + fs.readFileSync(ATUAL + '/base/src/versao.js', 'utf8').trim());
  let orq = fs.readFileSync(ATUAL + '/nuvem/orquestrador.js', 'utf8');
  const novoUnicos = fs.readFileSync(path.join(AQUI, 'unicos.js'));
  if (orq.includes("require('./unicos')")) {
    console.log('O orquestrador já tem o gancho da 3.9.14: só atualizo o unicos.js.');
  } else {
    const n = orq.split(ANCORA).length - 1;
    if (n !== 1) sair('Trecho do começo de rotasApp aparece ' + n + 'x no orquestrador. Pare aqui e mande esta tela para o Claude.');
    for (const nome of ['db', 'CFG']) if (!new RegExp('(^|\\n)(const|let) ' + nome + '\\b').test(orq)) sair('Orquestrador sem "' + nome + '". Mande esta tela para o Claude.');
    orq = orq.replace(ANCORA, () => ANCORA + GANCHO);
  }
  // CPF/CNPJ repetidos que já existem (só para mostrar; quem arruma é o unicos.js ao ligar)
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(DADOS + '/nuvem.db', { readOnly: true });
    const doc = "replace(replace(replace(replace(replace(replace(coalesce(documento,''),'.',''),'-',''),'/',''),' ',''),'CNPJ',''),'CPF','')";
    const g = d.prepare(`SELECT produto, ${doc} d, group_concat(slug, ', ') slugs, COUNT(*) n FROM lojas WHERE ${doc} <> '' GROUP BY produto, d HAVING n > 1`).all();
    console.log(g.length ? 'CPF/CNPJ repetidos agora (vão ficar com uma conta só):\n  ' + g.map(x => x.slugs).join('\n  ') : 'Nenhum CPF/CNPJ repetido no banco.');
    d.close();
  } catch (e) { console.log('(aviso) não consegui ler o banco só para conferir: ' + e.message); }

  // backup do código e do banco
  const quando = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  fs.mkdirSync(BACKUPS, { recursive: true });
  sh(`tar czf ${BACKUPS}/antes-3.9.15-cpf-${quando}.tgz -C ${APP} familia`);
  sh(`cp -a ${DADOS}/nuvem.db ${BACKUPS}/nuvem-antes-3.9.15-cpf-${quando}.db`);
  for (const x of ['-wal', '-shm']) if (fs.existsSync(DADOS + '/nuvem.db' + x)) sh(`cp -a ${DADOS}/nuvem.db${x} ${BACKUPS}/nuvem-antes-3.9.15-cpf-${quando}.db${x}`);
  console.log(`Backup: ${BACKUPS}/antes-3.9.15-cpf-${quando}.tgz e nuvem-antes-3.9.15-cpf-${quando}.db`);

  // pasta nova + sintaxe
  sh(`rm -rf ${NOVO} && cp -a ${ATUAL} ${NOVO}`);
  fs.writeFileSync(NOVO + '/nuvem/unicos.js', novoUnicos);
  fs.writeFileSync(NOVO + '/nuvem/orquestrador.js', orq);
  for (const rel of ['nuvem/unicos.js', 'nuvem/orquestrador.js']) {
    try { cp.execFileSync(process.execPath, ['--check', path.join(NOVO, rel)], { stdio: 'pipe' }); }
    catch (e) { sh(`rm -rf ${NOVO}`); sair('Erro de sintaxe em ' + rel + ': ' + String(e.stderr || e.message).slice(0, 300)); }
  }
  sh(`${DONO} ${NOVO}`);

  // troca e reinicia
  sh(`rm -rf ${ANTIGO} && mv ${ATUAL} ${ANTIGO} && mv ${NOVO} ${ATUAL}`);
  sh(REINICIAR);
  let ok = await saudavel();
  // primeira chamada ao app liga o unicos.js (arruma o banco e cria o índice); confere as respostas
  const pg = ok ? await pedir('app.' + DOMINIO, '/') : { status: '-' };
  const teste = ok ? await pedir('app.' + DOMINIO, '/api/site/cadastro', 'POST', JSON.stringify({ nome: 'Teste Servidor', whatsapp: '11', documento: '00000000000', email: 'x' })) : { status: '-' };
  if (!ok || pg.status !== 200 || teste.status !== 400) {
    console.log(`\nAlgo não respondeu certo (saúde ${ok}, página ${pg.status}, cadastro ${teste.status}). Voltando para a versão anterior…`);
    sh(`rm -rf ${APP}/familia.314 && mv ${ATUAL} ${APP}/familia.314 && mv ${ANTIGO} ${ATUAL}`);
    sh(REINICIAR); await saudavel();
    console.log('*** Voltei para a versão anterior. Mande esta tela para o Claude. (A tentativa ficou em ' + APP + '/familia.314)');
    process.exit(1);
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(DADOS + '/nuvem.db', { readOnly: true });
    const idx = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_lojas_documento'").get();
    const conf = d.prepare("SELECT slug, documento_conflito FROM lojas WHERE documento_conflito IS NOT NULL").all();
    console.log('Índice único de CPF/CNPJ: ' + (idx ? 'criado' : 'NÃO criado (mande a tela para o Claude)'));
    if (conf.length) console.log('Contas que ficaram sem CPF/CNPJ (o documento delas foi para documento_conflito):\n  ' + conf.map(x => x.slug).join('\n  '));
    d.close();
  } catch (e) { console.log('(aviso) ' + e.message); }
  console.log('\n== PRONTO: trava de CPF/CNPJ no ar. Serviço reiniciado e respondendo. ==');
  console.log('Voltar atrás: cd ' + APP + ' && mv familia familia.314 && mv familia.antigo familia && systemctl restart pronta-nuvem');
})().catch(e => { console.log('\n*** Erro: ' + e.message); process.exit(1); });
