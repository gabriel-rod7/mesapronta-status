'use strict';
// MesaPronta 3.9.15 no servidor: logo/banner no cardápio da mesa, pratos por dia da semana,
// escolha obrigatória (sabor), ler o QR da mesa pela câmera.
// Uso: node aplicar.js <commit> [--com-programa] [--ensaio] [--raiz <pasta familia>]
// - Trabalha numa cópia (familia.novo315), confere tudo, testa um sistema de verdade numa porta livre
//   e só então troca. Se algo der errado depois de trocar, volta sozinho.
// - Idempotente: rodar de novo não muda nada.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), http = require('node:http');

const args = process.argv.slice(2);
const COMMIT = args.find(a => /^[0-9a-f]{7,40}$/.test(a)) || 'main';
const ENSAIO = args.includes('--ensaio');
const COM_PROGRAMA = args.includes('--com-programa');
const iRaiz = args.indexOf('--raiz');
const RAIZ = iRaiz >= 0 ? path.resolve(args[iRaiz + 1]) : '/srv/pronta/app/familia';
const AQUI = __dirname;
const VERSAO = '3.9.15';
const BACKUPS = process.env.PRONTA_BACKUPS || '/srv/pronta/backups';
const MANIFESTO = process.env.PRONTA_MANIFESTO || '/srv/pronta/dados/atualizacao.json';
const EXE = { nome: `MesaPronta-${VERSAO}.exe.gz`, sha256: '7e72b07ea533a1eaba8ec472e6a0e0d9b47d4489a979c0a4e7065e7a641949fc', bytes: 95988224 };

const log = (...a) => console.log('[3.9.15]', ...a);
const parar = (msg) => { console.error('\n[3.9.15] PAROU: ' + msg + '\nNada foi trocado no servidor.'); process.exit(1); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sh = (c, o = {}) => cp.execSync(c, { stdio: ['ignore', 'pipe', 'pipe'], ...o }).toString();

// ---------------- arquivos de tela ----------------
// sha da 3.9.13 (como está no ar) -> arquivo novo (no publico.tgz)
const TELAS = {
  'js/caixa.js': 'df5661c65b8ee966',
  'js/comum.js': '39ba33f314f7f618',
  'js/menu-cliente.js': '3c7016167e87931d',
  'cardapio.html': 'e45a8c1f2361217a',
  'css/menu-cliente.css': '5efd2071f62ae953',
  'css/app.css': 'c148d158795c5182',
  'vendor/jsqr.js': null, // novo
};

// ---------------- funções novas (vão no fim dos arquivos que usam) ----------------
const AJUDANTES = `

// ---- 3.9.15: pratos por dia e escolha obrigatória ----
function __mpDiaOk(p, d = new Date()) { const l = String((p && p.dias) || '').split(',').filter(Boolean).map(Number); return !l.length || l.includes(d.getDay()); }
function __mpEscolhaDe(p) { try { const e = typeof p.escolhas === 'string' ? JSON.parse(p.escolhas || 'null') : p.escolhas; return e && Array.isArray(e.opcoes) && e.opcoes.length ? { titulo: String(e.titulo || 'Sabor'), opcoes: e.opcoes.map(String) } : null; } catch { return null; } }
function __mpEscolhaTexto(v) { let e = v; if (typeof e === 'string') { try { e = JSON.parse(e || 'null'); } catch { e = null; } } if (!e || !Array.isArray(e.opcoes)) return ''; const l = e.opcoes.map(t => String(t ?? '').trim().slice(0, 40)).filter(Boolean).filter((t, i, a) => a.findIndex(x => x.toLowerCase() === t.toLowerCase()) === i).slice(0, 40); return l.length ? JSON.stringify({ titulo: String(e.titulo || '').trim().slice(0, 30) || 'Sabor', opcoes: l }) : ''; }
function __mpDiasTexto(v) { return [...new Set(String(v || '').split(',').map(t => t.trim()).filter(t => /^[0-6]$/.test(t)))].sort().join(','); }
`;
const MARCA = '// ---- 3.9.15: pratos por dia e escolha obrigatória ----';

function listarJs(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    if (n.name === 'node_modules' || n.name.startsWith('.')) continue;
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...listarJs(p)); else if (n.name.endsWith('.js')) out.push(p);
  }
  return out;
}
function mostrarPerto(txt, re, n = 3) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); let m, k = 0;
  while ((m = r.exec(txt)) && k++ < n) console.error('   …' + txt.slice(Math.max(0, m.index - 120), m.index + 160).replace(/\s+/g, ' ') + '…');
}

// aplica os remendos no código do servidor (texto -> texto); devolve { arquivos alterados }
function remendar(fontes) {
  const usados = new Set();
  const achar = (re, esperado, nome) => {
    const res = [];
    for (const [f, t] of Object.entries(fontes)) { const r = new RegExp(re.source, 'g'); let m; while ((m = r.exec(t))) res.push({ f, m, i: m.index }); }
    if (res.length !== esperado) {
      console.error(`\n[3.9.15] Remendo "${nome}": esperava ${esperado}, achei ${res.length}.`);
      for (const x of res.slice(0, 5)) console.error('   ' + path.basename(x.f) + ': …' + fontes[x.f].slice(Math.max(0, x.i - 100), x.i + 160).replace(/\s+/g, ' ') + '…');
      parar(`o código do servidor não está como esperado (remendo "${nome}"). Mande este texto para o suporte.`);
    }
    return res;
  };
  const trocar = (f, i, len, novo) => { fontes[f] = fontes[f].slice(0, i) + novo + fontes[f].slice(i + len); usados.add(f); };

  // já aplicado?
  if (Object.values(fontes).some(t => t.includes(MARCA))) return { jaAplicado: true, usados };

  // A) colunas novas
  for (const x of achar(/([\w$]+)\(\s*(['"])produtos\2\s*,\s*\2foto\2\s*,\s*\2TEXT\2\s*\)\s*;/, 1, 'colunas')) {
    const fn = x.m[1];
    trocar(x.f, x.i, x.m[0].length, x.m[0] + ` ${fn}('produtos', 'dias', "TEXT NOT NULL DEFAULT ''"); ${fn}('produtos', 'escolhas', "TEXT NOT NULL DEFAULT ''");`);
  }
  // B) campos do cadastro de produtos
  for (const x of achar(/(['"])promo_ate\1\s*,\s*\1destaque\1\s*,\s*\1foto\1/, 1, 'campos')) {
    const q = x.m[1]; trocar(x.f, x.i, x.m[0].length, x.m[0] + `, ${q}dias${q}, ${q}escolhas${q}`);
  }
  // C) normalizar dias e escolhas ao salvar
  {
    const [x] = achar(/for\s*\(\s*(?:const|let|var)\s+([\w$]+)\s+of\s*\[\s*(['"])preco\2\s*,\s*\2taxa\2\s*,\s*\2custo\2\s*,\s*\2promo_preco\2\s*,?\s*\]\s*\)/, 1, 'normalizar');
    const t = fontes[x.f], k = x.m[1];
    const depois = t.slice(x.i + x.m[0].length, x.i + x.m[0].length + 200);
    const md = depois.match(new RegExp(`^\\s*\\{?\\s*(?:if\\s*\\(\\s*${k.replace('$', '\\$')}\\s+in\\s+([\\w$]+)\\s*\\)|${k.replace('$', '\\$')}\\s+in\\s+([\\w$]+)\\s*&&)`));
    if (!md) { console.error('   …' + depois.replace(/\s+/g, ' ')); parar('não achei a variável dos dados (remendo "normalizar").'); }
    const D = md[1] || md[2];
    const antes = t.slice(Math.max(0, x.i - 6000), x.i);
    const fs_ = [...antes.matchAll(/function\s+[\w$]+\s*\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)/g)].pop();
    if (!fs_ || fs_[2] !== D) parar('não achei a função de normalizar o cadastro (remendo "normalizar").');
    const T = fs_[1];
    const fim = t.slice(0, x.i).replace(/\s+$/, '');
    if (!/[;{}]$/.test(fim)) parar('o "for" de normalizar não está no começo de uma linha (remendo "normalizar").');
    trocar(x.f, x.i, 0, `if (${T} === 'produtos' && 'dias' in ${D}) ${D}.dias = __mpDiasTexto(${D}.dias);\n  if (${T} === 'produtos' && 'escolhas' in ${D}) ${D}.escolhas = __mpEscolhaTexto(${D}.escolhas);\n  `);
  }
  // D) cardápio: escolha e se o prato vale hoje
  for (const x of achar(/promo_ativa\s*:\s*[\w$.]+\(\s*([\w$]+)\s*\)\s*,\s*preco_atual\s*:/, 1, 'cardapio')) {
    const p = x.m[1]; trocar(x.f, x.i, 0, `escolha: __mpEscolhaDe(${p}), dia_ok: __mpDiaOk(${p}), `);
  }
  // E) os 3 cardápios do cliente (mesa, online, totem) só com os pratos do dia
  // (só os .filter(p => !p.por_quilo ...) dos cardápios; os "if (!prod.por_quilo)" da balança ficam como estão)
  for (const x of achar(/\.filter\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*!\1\.por_quilo\b/, 3, 'filtro do dia').reverse()) {
    const p = x.m[1], ini = x.i + x.m[0].lastIndexOf('!'), len = x.i + x.m[0].length - ini;
    trocar(x.f, ini, len, `(!${p}.por_quilo && ${p}.dia_ok !== false)`);
  }
  // F) e mandam a escolha e os dias
  for (const x of achar(/destaque\s*:\s*!!([\w$]+)\.destaque\s*,\s*foto\s*:\s*\1\.foto\s*\|\|\s*null/, 3, 'campos publicos').reverse()) {
    const p = x.m[1]; trocar(x.f, x.i, x.m[0].length, x.m[0] + `, escolha: ${p}.escolha || null, dias: ${p}.dias || ''`);
  }
  // G) pedido pela mesa: recusa prato fora do dia e sem a escolha
  {
    const [x] = achar(/([\w$]+)\(\s*400\s*,\s*(['"])Escolha pelo menos um item\2\s*\)\s*;/, 1, 'pedido da mesa');
    const t = fontes[x.f], F = x.m[1];
    const antes = t.slice(Math.max(0, x.i - 600), x.i);
    const mi = [...antes.matchAll(/[\s,;{(]([\w$]+)\s*=\s*Array\.isArray\(/g)].pop();
    const depois = t.slice(x.i, x.i + 2500);
    const mdb = depois.match(/([\w$]+)\.prepare\(/);
    if (!mi || !mdb) parar('não achei as variáveis do pedido da mesa (remendo "pedido da mesa").');
    const I = mi[1], DB = mdb[1];
    let fim = x.i + x.m[0].length;
    { const resto = t.slice(fim); const mb = resto.match(/^\s*\}/); if (mb) fim += mb[0].length; }
    trocar(x.f, fim, 0, `\n    for (const __it of ${I}) { const __p = ${DB}.prepare('SELECT nome, dias, escolhas FROM produtos WHERE id = ?').get(Math.round(Number(__it && __it.produto_id)) || 0); if (!__p) continue; if (!__mpDiaOk(__p)) ${F}(400, \`\${__p.nome} não está disponível hoje\`); const __e = __mpEscolhaDe(__p); if (__e && !__e.opcoes.some((o) => String(__it.obs || '').toLowerCase().includes((__e.titulo + ': ' + o).toLowerCase()))) ${F}(400, \`Escolha \${__e.titulo.toLowerCase()} de \${__p.nome}\`); }`);
  }
  for (const f of usados) if (/__mp(DiaOk|EscolhaDe|EscolhaTexto|DiasTexto)\(/.test(fontes[f])) fontes[f] += AJUDANTES;
  return { jaAplicado: false, usados };
}

function pedir(porta, metodo, caminho, corpo, token) {
  return new Promise((ok, falha) => {
    const b = corpo != null ? Buffer.from(JSON.stringify(corpo)) : null;
    const r = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers: { 'Content-Type': 'application/json', ...(b ? { 'Content-Length': b.length } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, timeout: 15000 }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } ok({ status: res.statusCode, json: j }); });
    });
    r.on('error', falha); r.on('timeout', () => r.destroy(new Error('tempo esgotado'))); if (b) r.write(b); r.end();
  });
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// sobe um sistema da cópia nova numa pasta de dados temporária e confere as funções novas
async function autoteste(raizNova) {
  const dados = fs.mkdtempSync('/tmp/mp315-'), porta = 39000 + Math.floor(Math.random() * 900);
  const servidor = path.join(raizNova, 'base', 'src', 'server.js');
  if (!fs.existsSync(servidor)) parar('não achei base/src/server.js na cópia nova');
  const p = cp.spawn(process.execPath, ['--disable-warning=ExperimentalWarning', servidor], { env: { ...process.env, PRONTA_OFFLINE: '1', PRONTA_NUVEM: '', PORT: String(porta), MESAPRONTA_DATA: dados, PRONTA_DATA: dados, PRODUTO: 'restaurante' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = ''; p.stdout.on('data', (d) => { saida += d; }); p.stderr.on('data', (d) => { saida += d; });
  const erros = [];
  const conf = (c, m) => { if (!c) erros.push(m); };
  try {
    let info = null;
    for (let i = 0; i < 40 && !info; i++) { await esperar(500); try { const r = await pedir(porta, 'GET', '/api/info'); if (r.status === 200) info = r.json; } catch {} }
    if (!info) { console.error(saida.slice(-2000)); throw new Error('o sistema de teste não abriu'); }
    conf(info.versao === VERSAO, 'versão ' + info.versao);
    const lg = await pedir(porta, 'POST', '/api/login', { pin: '1234' }); const tk = lg.json && lg.json.token;
    conf(!!tk, 'login'); if (!tk) throw new Error('login do teste falhou');
    await pedir(porta, 'PUT', '/api/config', { cardapio_digital_ativo: '1', cliente_pode_pedir: '1', cliente_pedido_precisa_aprovacao: '0' }, tk);
    const ps = (await pedir(porta, 'GET', '/api/cad/produtos', null, tk)).json;
    const a = ps[0], b = ps[1];
    const hoje = new Date().getDay(), outro = (hoje + 3) % 7;
    const r1 = await pedir(porta, 'PUT', `/api/cad/produtos/${a.id}`, { dias: `${outro},9,x,${outro}` }, tk);
    conf(r1.json && r1.json.dias === String(outro), 'dias normalizados');
    const r2 = await pedir(porta, 'PUT', `/api/cad/produtos/${b.id}`, { escolhas: { titulo: ' ', opcoes: ['Laranja', 'laranja', ' Uva ', ''] } }, tk);
    conf(r2.json && r2.json.escolhas === JSON.stringify({ titulo: 'Sabor', opcoes: ['Laranja', 'Uva'] }), 'escolha normalizada');
    const pub = (await pedir(porta, 'GET', '/api/publico/cardapio')).json;
    conf(!pub.produtos.some(x => x.id === a.id), 'prato de outro dia some do cardápio da mesa');
    conf(pub.produtos.some(x => x.id === b.id && x.escolha && x.escolha.opcoes[1] === 'Uva'), 'cardápio da mesa manda a escolha');
    const eq = (await pedir(porta, 'GET', '/api/cardapio', null, tk)).json;
    conf(eq.produtos.some(x => x.id === a.id), 'equipe continua vendo o prato');
    const mesas = (await pedir(porta, 'GET', '/api/cad/mesas', null, tk)).json;
    const token = mesas[0] && mesas[0].token;
    if (token) {
      const p1 = await pedir(porta, 'POST', '/api/publico/pedido', { m: token, itens: [{ produto_id: a.id, qtd: 1, adicionais: [] }] });
      conf(p1.status === 400, 'pedido fora do dia recusado');
      const p2 = await pedir(porta, 'POST', '/api/publico/pedido', { m: token, itens: [{ produto_id: b.id, qtd: 1, adicionais: [] }] });
      conf(p2.status === 400, 'pedido sem a escolha recusado');
      const p3 = await pedir(porta, 'POST', '/api/publico/pedido', { m: token, itens: [{ produto_id: b.id, qtd: 1, adicionais: [], obs: 'Sabor: Uva' }] });
      conf(p3.status === 200, 'pedido com a escolha aceito ' + p3.status + ' ' + JSON.stringify(p3.json).slice(0, 120));
    } else erros.push('sem mesa para testar');
    for (const pg of ['/cardapio', '/vendor/jsqr.js', '/js/menu-cliente.js']) { const r = await pedir(porta, 'GET', pg); conf(r.status === 200, 'abre ' + pg); }
    const card = await pedir(porta, 'GET', '/cardapio'); conf(String(card.json).includes('lerQrMesa'), 'cardápio com o leitor de QR');
  } finally {
    p.kill('SIGTERM'); await esperar(400);
    try { fs.rmSync(dados, { recursive: true, force: true }); } catch {}
  }
  if (erros.length) parar('o teste da cópia nova falhou: ' + erros.join('; '));
  log('teste da cópia nova: tudo certo');
}

async function saude() {
  for (let i = 0; i < 20; i++) {
    await esperar(1500);
    try {
      const ativo = sh('systemctl is-active pronta-nuvem || true').trim();
      const r = await new Promise((ok) => { const q = http.get({ host: '127.0.0.1', port: 8080, path: '/', headers: { Host: 'app.mesapronta.net' }, timeout: 5000 }, (s) => { s.resume(); ok(s.statusCode); }); q.on('error', () => ok(0)); q.on('timeout', () => { q.destroy(); ok(0); }); });
      if (ativo === 'active' && r > 0 && r < 500) return true;
    } catch {}
  }
  return false;
}

(async () => {
  if (!fs.existsSync(path.join(RAIZ, 'base', 'src'))) parar('não achei ' + RAIZ + '/base/src');
  const publico = path.join(RAIZ, 'base', 'public');
  const pacoteTelas = path.join(AQUI, 'publico.tgz');
  if (!fs.existsSync(pacoteTelas)) parar('falta o publico.tgz ao lado do aplicar.js');
  const telasDir = fs.mkdtempSync('/tmp/mp315-telas-');
  sh(`tar xzf ${JSON.stringify(pacoteTelas)} -C ${JSON.stringify(telasDir)}`);

  // 1) confere o que está no ar
  const fontesVivas = Object.fromEntries(listarJs(path.join(RAIZ, 'base', 'src')).map(f => [f, fs.readFileSync(f, 'utf8')]));
  const versaoArq = Object.keys(fontesVivas).find(f => path.basename(f) === 'versao.js');
  const versaoAtual = versaoArq ? (fontesVivas[versaoArq].match(/['"](\d+\.\d+\.\d+)['"]/) || [])[1] : null;
  log('versão no servidor:', versaoAtual || '(não achei)');
  const telas = [];
  for (const [rel, curto] of Object.entries(TELAS)) {
    const novo = fs.readFileSync(path.join(telasDir, rel));
    const alvo = path.join(publico, rel);
    const atual = fs.existsSync(alvo) ? fs.readFileSync(alvo) : null;
    if (atual && sha(atual) === sha(novo)) continue;
    if (curto && (!atual || !sha(atual).startsWith(curto))) parar(`a tela ${rel} do servidor não é a da 3.9.13 (sha ${atual ? sha(atual).slice(0, 16) : 'sem arquivo'}).`);
    telas.push([rel, novo]);
  }
  // 2) remenda numa cópia em memória
  const fontes = { ...fontesVivas };
  const r = remendar(fontes);
  if (versaoArq && versaoAtual !== VERSAO) { fontes[versaoArq] = fontes[versaoArq].replace(/(['"])\d+\.\d+\.\d+\1/, `'${VERSAO}'`); r.usados.add(versaoArq); }
  if (r.jaAplicado && !telas.length && versaoAtual === VERSAO) log('o código e as telas já estão na 3.9.15.');
  else log(`remendos ok em ${[...r.usados].map(f => path.relative(RAIZ, f)).join(', ') || '(nenhum)'}; telas novas: ${telas.map(t => t[0]).join(', ') || '(nenhuma)'}`);

  const precisaTrocar = r.usados.size || telas.length;
  if (precisaTrocar) {
    // 3) monta a cópia nova
    const nova = RAIZ + '.novo315';
    fs.rmSync(nova, { recursive: true, force: true });
    sh(`cp -a ${JSON.stringify(RAIZ)} ${JSON.stringify(nova)}`);
    for (const f of r.usados) {
      const destino = path.join(nova, path.relative(RAIZ, f));
      fs.writeFileSync(destino, fontes[f]);
      try { sh(`${JSON.stringify(process.execPath)} --check ${JSON.stringify(destino)}`); } catch (e) { parar('erro de sintaxe em ' + path.relative(RAIZ, f) + ': ' + (e.stderr || e.message)); }
    }
    for (const [rel, novo] of telas) { const d = path.join(nova, 'base', 'public', rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, novo); }
    // dono dos arquivos igual ao da pasta original
    try { const st = fs.statSync(RAIZ); sh(`chown -R ${st.uid}:${st.gid} ${JSON.stringify(nova)}`); } catch {}
    await autoteste(nova);
    if (ENSAIO) { log('ENSAIO: cópia nova pronta e testada em', nova, '(não troquei nada)'); return; }
    // 4) backup e troca
    fs.mkdirSync(BACKUPS, { recursive: true });
    const bk = path.join(BACKUPS, `antes-3.9.15-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.tgz`);
    sh(`tar czf ${JSON.stringify(bk)} -C ${JSON.stringify(path.dirname(RAIZ))} ${JSON.stringify(path.basename(RAIZ))}`);
    log('backup:', bk);
    const antiga = RAIZ + '.antigo';
    fs.rmSync(antiga, { recursive: true, force: true });
    fs.renameSync(RAIZ, antiga); fs.renameSync(nova, RAIZ);
    log('código trocado; a pasta anterior ficou em', antiga);
  }
  // 5) programa do computador: manifesto da atualização automática
  let manifestoAntes = null;
  if (COM_PROGRAMA && !ENSAIO) {
    if (COMMIT === 'main') parar('para --com-programa passe o commit (o link do programa precisa ser fixo).');
    if (!fs.existsSync(MANIFESTO)) parar('não achei ' + MANIFESTO);
    manifestoAntes = fs.readFileSync(MANIFESTO, 'utf8');
    const m = JSON.parse(manifestoAntes);
    log('manifesto antes:', JSON.stringify(m));
    const chaves = Object.keys(m);
    const kVer = chaves.find(k => /^vers/.test(k)), kUrl = chaves.find(k => /url/i.test(k)), kSha = chaves.find(k => /sha/i.test(k)), kTam = chaves.find(k => /^(tamanho|bytes|size)$/i.test(k));
    if (!kVer || !kUrl || !kSha) parar('o manifesto não tem versão/url/sha como esperado; não mexi nele.');
    const url = `https://raw.githubusercontent.com/gabriel-rod7/mesapronta-status/${COMMIT}/download/${EXE.nome}`;
    // confere o arquivo publicado antes de apontar para ele
    const tmp = '/tmp/' + EXE.nome;
    sh(`curl -fsSL -o ${tmp} ${url}`);
    const exe = cp.execSync(`gunzip -c ${tmp}`, { maxBuffer: 300 * 1024 * 1024 });
    fs.rmSync(tmp, { force: true });
    if (sha(exe) !== EXE.sha256 || exe.length !== EXE.bytes) parar(`o .exe baixado do GitHub não confere (sha ${sha(exe).slice(0, 16)}, ${exe.length} bytes). O código já foi trocado, mas o manifesto não.`);
    fs.copyFileSync(MANIFESTO, MANIFESTO + '.antes-3.9.15');
    m[kVer] = VERSAO; m[kUrl] = url; m[kSha] = EXE.sha256; if (kTam) m[kTam] = EXE.bytes;
    fs.writeFileSync(MANIFESTO, JSON.stringify(m, null, 2));
    log('manifesto agora:', JSON.stringify(m));
  }
  if (!precisaTrocar && !COM_PROGRAMA) { log('nada a fazer.'); return; }
  if (ENSAIO) return;
  // 6) reinicia e confere; se não subir, volta
  sh('systemctl restart pronta-nuvem');
  if (await saude()) { log(`PRONTO — servidor na ${VERSAO}, serviço ativo.`); return; }
  console.error('[3.9.15] o serviço não respondeu depois da troca. Voltando…');
  if (precisaTrocar) { fs.renameSync(RAIZ, RAIZ + '.falhou315'); fs.renameSync(RAIZ + '.antigo', RAIZ); }
  if (manifestoAntes) fs.writeFileSync(MANIFESTO, manifestoAntes);
  sh('systemctl restart pronta-nuvem');
  console.error('[3.9.15] voltei para a versão anterior. A pasta que falhou ficou em ' + RAIZ + '.falhou315');
  process.exit(1);
})().catch((e) => parar(e.stack || e.message));
