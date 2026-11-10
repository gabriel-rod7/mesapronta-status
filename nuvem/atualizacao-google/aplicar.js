'use strict';
// MesaPronta no servidor: "Entrar com Google" e "Cadastrar com Google" do site mesapronta.net.
// Uso: node aplicar.js <commit> [--ensaio] [--client-id <ID>.apps.googleusercontent.com] [--raiz <pasta familia>]
// - Põe nuvem/google.js (ao lado deste script) e liga ele no nuvem/orquestrador.js com 3 remendos pequenos
//   (cada um tem que achar o trecho exatamente 1 vez) + 2 frases opcionais nas telas de entrar.
// - Trabalha numa cópia (familia.novogoogle), sobe um orquestrador de teste com chaves do Google de mentira
//   (pasta de dados temporária, nada da produção) e só então troca. Se o serviço não voltar, desfaz sozinho.
// - --client-id grava GOOGLE_CLIENT_ID no /etc/pronta-nuvem.env (o Client ID não é segredo; sem ele o botão fica desligado).
// - --ensaio: faz tudo (cópia, remendos, teste) e não troca nada. Rode primeiro.
// - Idempotente: rodar de novo não muda nada.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), http = require('node:http'), os = require('node:os');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ENSAIO = args.includes('--ensaio');
const RAIZ = path.resolve(opt('--raiz') || '/srv/pronta/app/familia');
const CLIENT_ID = opt('--client-id');
const AQUI = __dirname;
const NOME = 'google';
const BACKUPS = process.env.PRONTA_BACKUPS || '/srv/pronta/backups';
const ENV_ARQ = process.env.PRONTA_ENV || '/etc/pronta-nuvem.env';
const MARCA = '// ---- google: entrar e cadastrar com Google (site) ----';

const log = (...a) => console.log('[google]', ...a);
const parar = (msg) => { console.error('\n[google] PAROU: ' + msg + '\nNada foi trocado no servidor.'); process.exit(1); };
class RemendoErro extends Error {}
const falhar = (msg) => { throw new RemendoErro(msg); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sh = (c, o = {}) => cp.execSync(c, { stdio: ['ignore', 'pipe', 'pipe'], ...o }).toString();
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const perto = (t, i, antes = 120, depois = 160) => '…' + t.slice(Math.max(0, i - antes), i + depois).replace(/\s+/g, ' ') + '…';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

if (CLIENT_ID != null && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID)) parar('o --client-id tem que terminar em .apps.googleusercontent.com (copie do Google Cloud Console).');

// ---------------- remendos do orquestrador ----------------
function remendar(t) {
  if (t.includes(MARCA)) return { texto: t, jaAplicado: true, opcionais: [] };
  const falhas = [], opcionais = [];
  const achar = (re, nome) => {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); const res = []; let m;
    while ((m = r.exec(t))) res.push(m);
    if (res.length !== 1) { console.error(`\n[google] Remendo "${nome}": esperava 1, achei ${res.length}.`); for (const x of res.slice(0, 3)) console.error('   ' + perto(t, x.index)); falhar(`o orquestrador não está como esperado (remendo "${nome}").`); }
    return res[0];
  };
  const tentar = (nome, fn) => { try { fn(); } catch (e) { if (!(e instanceof RemendoErro)) throw e; falhas.push(nome + ') ' + e.message); } };
  const inserir = (i, novo) => { t = t.slice(0, i) + novo + t.slice(i); };

  // nomes do orquestrador que o google.js usa (tem que existir todos)
  tentar('nomes', () => {
    for (const n of ['criarEntradaUnica', 'bloqueado', 'falhou', 'ipDe', 'lerJson', 'json', 'ESQ', 'PORTA_URL', 'db', 'cadastroSite', 'rotasApp'])
      if (!new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?(?:function\\s+${n}\\s*\\(|const\\s+${n}\\s*=)`).test(t)) falhar(`não achei "${n}" no orquestrador.`);
  });
  // A) carrega o módulo
  tentar('A', () => {
    const m = achar(/const\s*\{\s*DatabaseSync\s*\}\s*=\s*require\(\s*(['"])node:sqlite\1\s*\)\s*;/, 'require');
    inserir(m.index + m[0].length, `\nconst __mpGoogle = require('./google');   ${MARCA}`);
  });
  // B) rota POST /api/site/google, ao lado do cadastro do site
  tentar('B', () => {
    const m = achar(/if\s*\(\s*url\.pathname\s*===\s*(['"])\/api\/site\/cadastro\1\s*\)\s*return\s+cadastroSite\(\s*req\s*,\s*res\s*,\s*dominio\s*,\s*produto\s*\)\s*;/, 'rota');
    if (!/const\s+produto\s*=/.test(t.slice(Math.max(0, m.index - 600), m.index))) falhar('não achei "const produto =" logo antes da rota do cadastro (remendo "rota").');
    inserir(m.index, "if (url.pathname === '/api/site/google') return __mpGoogle.rota(req, res, { dominio, produto, db, json, lerJson, ipDe, bloqueado, falhou, criarEntradaUnica, urlLoja: (l) => `${ESQ}://${l.slug}.${l.dominio}${PORTA_URL}` });\n  ");
  });
  // C) cadastro do site: bilhete do Google vira o e-mail confirmado (antes das validações)
  tentar('C', () => {
    const m = achar(/if\s*\(\s*([\w$]+)\.botcheck\s*===\s*true[^\n]*?return\s+json\(\s*res\s*,\s*200\s*,\s*\{\s*ok\s*:\s*false\s*\}\s*,\s*([\w$]+)\s*\)\s*;/, 'cadastro');
    const [, b, cors] = m;
    inserir(m.index + m[0].length, `\n  { const __g = __mpGoogle.doCadastro(${b}); if (__g && __g.erro) return json(res, 400, { ok: false, erro: 'dados', campo: 'email', mensagem: __g.erro }, ${cors}); }`);
  });
  // D, E) opcionais: avisar nas telas de entrar que quem criou a conta com o Google entra pelo site
  {
    const re = /(<p><b>Dono da conta:<\/b> entre com o e-mail e a senha do cadastro\.)(<\/p>)/g; const ms = [...t.matchAll(re)];
    if (ms.length === 1) { inserir(ms[0].index + ms[0][1].length, ' Criou a conta com o Google? <a href="https://${loja.dominio}/entrar">Entre com o Google</a>.'); opcionais.push('tela de liberar aparelho'); }
    else console.log(`[google] (opcional) frase da tela de liberar aparelho: achei ${ms.length}, deixei como está.`);
  }
  {
    const re = /(<p>Use o e-mail e a senha que você cadastrou\.)(<\/p>)/g; const ms = [...t.matchAll(re)];
    if (ms.length === 1) { inserir(ms[0].index + ms[0][1].length, ' Criou a conta com o Google? <a href="https://${dominio}/entrar">Entre com o Google</a>.'); opcionais.push('tela Entrar do app'); }
    else console.log(`[google] (opcional) frase da tela Entrar do app: achei ${ms.length}, deixei como está.`);
  }
  if (falhas.length) parar(`${falhas.length} remendo(s) não bateram com o orquestrador:\n` + falhas.map(f => '  - ' + f).join('\n') + '\nMande este texto para o suporte.');
  return { texto: t + `\n${MARCA}\n`, jaAplicado: false, opcionais };
}

// ---------------- teste da cópia nova ----------------
function pedir(porta, metodo, caminho, corpo, extra = {}) {
  return new Promise((ok, falha) => {
    const b = corpo != null ? Buffer.from(JSON.stringify(corpo)) : null;
    const r = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers: { 'Content-Type': 'application/json', ...(b ? { 'Content-Length': b.length } : {}), ...extra }, timeout: 60000 }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } ok({ status: res.statusCode, json: j, headers: res.headers }); });
    });
    r.on('error', falha); r.on('timeout', () => r.destroy(new Error('tempo esgotado'))); if (b) r.write(b); r.end();
  });
}
function cpfTeste() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)); if (new Set(d).size === 1) d[0] = (d[0] + 1) % 10;
  for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += d[i] * (n + 1 - i); d.push((s * 10) % 11 % 10); }
  return d.join('');
}
async function autoteste(raizNova, OPC = []) {
  const orq = path.join(raizNova, 'nuvem', 'orquestrador.js');
  const dados = tmpDir('mpgoogle-'), porta = 38000 + Math.floor(Math.random() * 900), CID = 'teste-123.apps.googleusercontent.com';
  // "Google" de mentira: chave RSA própria e um endereço local com as chaves públicas
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'teste1', alg: 'RS256', use: 'sig' };
  const jw = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' }); s.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(ok => jw.listen(0, '127.0.0.1', ok));
  const assinar = (claims, chave = privateKey, kid = 'teste1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const agora = Math.floor(Date.now() / 1000);
    const p = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CID, sub: '1234567890', email_verified: true, iat: agora, exp: agora + 3600, ...claims })).toString('base64url');
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), chave).toString('base64url')}`;
  };
  const env = { PATH: process.env.PATH, HOME: dados, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), TZ: 'America/Sao_Paulo', PORTA: String(porta), DADOS: path.join(dados, 'd'), BACKUPS: path.join(dados, 'b'), TESTE_LOCAL: '1', DOMINIOS: 'mesapronta.net:restaurante', GOOGLE_CLIENT_ID: CID, GOOGLE_JWKS_URL: `http://127.0.0.1:${jw.address().port}/certs`, CHAVE_LICENCA: path.join(dados, 'nao-existe.pem'), ADMIN_SENHA: '' };
  const p = cp.spawn(process.execPath, ['--disable-warning=ExperimentalWarning', orq], { cwd: path.dirname(orq), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = ''; p.stdout.on('data', (d) => { saida += d; }); p.stderr.on('data', (d) => { saida += d; });
  const erros = []; const conf = (c, m) => { if (!c) erros.push(m); };
  const O = { Origin: 'https://mesapronta.net' };
  const google = (credential) => pedir(porta, 'POST', '/api/site/google', { credential }, O);
  try {
    let pronto = false;
    for (let i = 0; i < 40 && !pronto; i++) { await esperar(500); try { const r = await pedir(porta, 'GET', '/__saude'); pronto = r.status === 200; } catch {} }
    if (!pronto) { console.error(saida.slice(-2000)); throw new Error('o orquestrador de teste não abriu'); }
    const pre = await pedir(porta, 'OPTIONS', '/api/site/google', null, O);
    conf(pre.status === 204 && pre.headers['access-control-allow-origin'] === 'https://mesapronta.net', 'CORS do site ' + pre.status);
    const fora = await pedir(porta, 'OPTIONS', '/api/site/google', null, { Origin: 'https://golpe.com' });
    conf(!fora.headers['access-control-allow-origin'], 'CORS recusa outra origem');
    conf((await google('lixo')).status === 401, 'token mal formado recusado');
    const outra = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    conf((await google(assinar({ email: 'a@b.com' }, outra))).status === 401, 'assinatura falsa recusada');
    conf((await google(assinar({ email: 'a@b.com', aud: 'outro.apps.googleusercontent.com' }))).status === 401, 'Client ID errado recusado');
    conf((await google(assinar({ email: 'a@b.com', iss: 'https://golpe.com' }))).status === 401, 'emissor errado recusado');
    conf((await google(assinar({ email: 'a@b.com', exp: Math.floor(Date.now() / 1000) - 600 }))).status === 401, 'token vencido recusado');
    conf((await google(assinar({ email: 'a@b.com', email_verified: false }))).status === 401, 'e-mail não confirmado recusado');
    // e-mail novo: devolve o bilhete para o cadastro
    const email = 'teste.google.' + Date.now() + '@exemplo.com';
    const g1 = await google(assinar({ email: email.toUpperCase(), name: 'Maria Teste Google' }));
    conf(g1.status === 200 && g1.json.ok && g1.json.conta === false && g1.json.email === email && g1.json.nome === 'Maria Teste Google' && /^g1\./.test(g1.json.google || ''), 'e-mail novo devolve bilhete ' + JSON.stringify(g1.json).slice(0, 160));
    const corpo = { produto: 'mesapronta', forma: 'online', nome: 'Maria Teste', whatsapp: '7399' + String(Math.floor(1e7 + Math.random() * 8e7)).slice(0, 7), email: 'ignorado@exemplo.com', documento: cpfTeste(), tipo_documento: 'CPF', estabelecimento: 'Cantina Teste Google', tipo: 'Restaurante', cep: '45650000', rua: 'Rua A', numero: '10', complemento: '', bairro: 'Centro', cidade: 'Ilhéus', uf: 'BA', utm: { utm_source: 'teste' }, botcheck: false };
    const ruim = await pedir(porta, 'POST', '/api/site/cadastro', { ...corpo, google: g1.json.google.slice(0, -3) + 'abc' }, O);
    conf(ruim.status === 400 && ruim.json.campo === 'email', 'bilhete adulterado recusado ' + ruim.status);
    const cad = await pedir(porta, 'POST', '/api/site/cadastro', { ...corpo, google: g1.json.google }, O);
    conf(cad.status === 200 && cad.json.ok && /\/entrar\?t=/.test(cad.json.entrar || ''), 'cadastro com Google cria a conta ' + cad.status + ' ' + JSON.stringify(cad.json).slice(0, 200));
    // e-mail que já tem conta: entra direto
    const g2 = await google(assinar({ email, name: 'Maria' }));
    conf(g2.status === 200 && g2.json.conta === true && g2.json.forma === 'online' && /\/entrar\?t=/.test(g2.json.entrar || ''), 'conta existente entra com Google ' + JSON.stringify(g2.json).slice(0, 160));
    if (g2.json && g2.json.entrar) {
      const u = new URL(g2.json.entrar);
      const ent = await pedir(porta, 'GET', u.pathname + u.search, null, { Host: u.host });
      conf(ent.status === 200 && String(ent.headers['set-cookie'] || '').includes('pa='), 'link de entrada libera o aparelho ' + ent.status);
      const de2 = await pedir(porta, 'GET', u.pathname + u.search, null, { Host: u.host });
      conf(de2.status === 302, 'link de entrada só vale uma vez ' + de2.status);
      const inicio = await pedir(porta, 'GET', '/', null, { Host: u.host });
      if (OPC.includes('tela de liberar aparelho')) conf(inicio.status === 200 && /Entre com o Google/.test(String(inicio.json)), 'tela de liberar aparelho cita o Google');
    }
    // o cadastro antigo (e-mail + senha) continua igual
    const normal = await pedir(porta, 'POST', '/api/site/cadastro', { ...corpo, email: 'normal.' + Date.now() + '@exemplo.com', senha: 'segredo123', documento: cpfTeste(), whatsapp: '7398' + String(Math.floor(1e7 + Math.random() * 8e7)).slice(0, 7), estabelecimento: 'Cantina Normal' }, O);
    conf(normal.status === 200 && normal.json.ok, 'cadastro com e-mail e senha continua funcionando ' + normal.status + ' ' + JSON.stringify(normal.json).slice(0, 160));
    const app = await pedir(porta, 'GET', '/entrar'); conf(app.status === 200 && (!OPC.includes('tela Entrar do app') || /Entre com o Google/.test(String(app.json))), 'tela Entrar do app abre');
  } finally {
    if (process.platform === 'win32') { try { sh(`taskkill /pid ${p.pid} /T /F`); } catch {} } else p.kill('SIGTERM');
    jw.close(); await esperar(1500);
    try { fs.rmSync(dados, { recursive: true, force: true }); } catch {}
  }
  if (process.env.MP_VERBOSE) console.log('--- log do orquestrador de teste ---\n' + saida);
  if (/\b(TypeError|ReferenceError|SyntaxError)\b/.test(saida)) erros.push('erro no log do orquestrador de teste: ' + (saida.match(/.*\b(TypeError|ReferenceError|SyntaxError)\b.*/) || [''])[0]);
  if (erros.length) { console.error(saida.slice(-1500)); parar('o teste da cópia nova falhou: ' + erros.join('; ')); }
  log('teste da cópia nova: tudo certo (' + 'token falso, vencido, de outro site e e-mail não confirmado recusados; cadastro e entrada com Google; cadastro antigo ok)');
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
// Client ID no arquivo de ambiente do serviço. Devolve o texto anterior (para desfazer) ou null se não mexeu.
function gravarClientId() {
  if (!CLIENT_ID) return null;
  if (!fs.existsSync(ENV_ARQ)) parar('não achei ' + ENV_ARQ);
  try { const ef = sh('systemctl show -p EnvironmentFiles pronta-nuvem || true'); if (ef.trim() && !ef.includes(ENV_ARQ)) parar(`o serviço pronta-nuvem não lê ${ENV_ARQ} (${ef.trim()}). Não mexi em nada.`); } catch {}
  const antes = fs.readFileSync(ENV_ARQ, 'utf8');
  const linha = `GOOGLE_CLIENT_ID=${CLIENT_ID}`;
  if (antes.split(/\r?\n/).includes(linha)) { log('Client ID já está no', ENV_ARQ); return null; }
  const novo = /^GOOGLE_CLIENT_ID=.*$/m.test(antes) ? antes.replace(/^GOOGLE_CLIENT_ID=.*$/m, linha) : antes.replace(/\n?$/, '\n') + linha + '\n';
  fs.writeFileSync(ENV_ARQ + '.antes-google', antes, { mode: 0o600 });
  fs.writeFileSync(ENV_ARQ, novo, { mode: fs.statSync(ENV_ARQ).mode & 0o777 });
  log('Client ID gravado em', ENV_ARQ, '(cópia anterior em ' + ENV_ARQ + '.antes-google)');
  return antes;
}
async function conferirRota() {
  const r = await new Promise((ok) => {
    const b = Buffer.from('{"credential":"x"}');
    const q = http.request({ host: '127.0.0.1', port: 8080, method: 'POST', path: '/api/site/google', headers: { Host: 'app.mesapronta.net', 'Content-Type': 'application/json', 'Content-Length': b.length }, timeout: 8000 }, (s) => { let t = ''; s.on('data', d => t += d); s.on('end', () => ok({ status: s.statusCode, t })); });
    q.on('error', () => ok({ status: 0 })); q.on('timeout', () => { q.destroy(); ok({ status: 0 }); }); q.end(b);
  });
  if (r.status === 401) log('rota /api/site/google no ar e com o Client ID ligado (token de teste recusado, como devia).');
  else if (r.status === 503) log('rota /api/site/google no ar, mas SEM Client ID: rode de novo com --client-id <ID> para ligar o botão.');
  else log('rota /api/site/google respondeu', r.status, String(r.t || '').slice(0, 120));
  return r.status === 401 || r.status === 503;
}

(async () => {
  const ORQ = path.join(RAIZ, 'nuvem', 'orquestrador.js');
  if (!fs.existsSync(ORQ)) parar('não achei ' + ORQ);
  const MOD = fs.readFileSync(path.join(AQUI, 'google.js'));
  try { sh(`${JSON.stringify(process.execPath)} --check ${JSON.stringify(path.join(AQUI, 'google.js'))}`); } catch (e) { parar('google.js com erro de sintaxe'); }
  const atual = fs.readFileSync(ORQ, 'utf8');
  const modAtual = fs.existsSync(path.join(RAIZ, 'nuvem', 'google.js')) ? fs.readFileSync(path.join(RAIZ, 'nuvem', 'google.js')) : null;
  log('orquestrador sha', sha(atual).slice(0, 16), modAtual ? '· google.js já existe (sha ' + sha(modAtual).slice(0, 16) + ')' : '');
  const r = remendar(atual);
  const precisaTrocar = !r.jaAplicado || !modAtual || sha(modAtual) !== sha(MOD);
  log(r.jaAplicado ? 'remendos já aplicados.' : 'remendos ok' + (r.opcionais.length ? ' (+ frase do Google em: ' + r.opcionais.join(', ') + ')' : ''));

  if (precisaTrocar) {
    const nova = RAIZ + '.novogoogle';
    fs.rmSync(nova, { recursive: true, force: true });
    fs.cpSync(RAIZ, nova, { recursive: true });
    fs.writeFileSync(path.join(nova, 'nuvem', 'orquestrador.js'), r.texto);
    fs.writeFileSync(path.join(nova, 'nuvem', 'google.js'), MOD);
    try { sh(`${JSON.stringify(process.execPath)} --check ${JSON.stringify(path.join(nova, 'nuvem', 'orquestrador.js'))}`); } catch (e) { parar('erro de sintaxe no orquestrador remendado: ' + (e.stderr || e.message)); }
    try { const st = fs.statSync(RAIZ); if (process.platform !== 'win32') sh(`chown -R ${st.uid}:${st.gid} ${JSON.stringify(nova)}`); } catch {}
    await autoteste(nova, r.opcionais);
    if (ENSAIO) { log('ENSAIO: cópia nova pronta e testada em', nova, '(não troquei nada)'); return; }
    fs.mkdirSync(BACKUPS, { recursive: true });
    const bk = path.join(BACKUPS, `antes-${NOME}-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')}.tgz`);
    sh(`tar czf ${JSON.stringify(bk)} -C ${JSON.stringify(path.dirname(RAIZ))} ${JSON.stringify(path.basename(RAIZ))}`);
    log('backup:', bk);
    const antiga = RAIZ + '.antigo';
    fs.rmSync(antiga, { recursive: true, force: true });
    fs.renameSync(RAIZ, antiga); fs.renameSync(nova, RAIZ);
    log('código trocado; a pasta anterior ficou em', antiga);
  } else if (ENSAIO) { log('ENSAIO: o código já está com o Google.' + (CLIENT_ID ? ' O Client ID seria conferido/gravado na hora de verdade.' : '')); return; }

  const envAntes = ENSAIO ? null : gravarClientId();
  if (!precisaTrocar && envAntes == null) { log('nada a fazer.'); await conferirRota(); return; }
  sh('systemctl restart pronta-nuvem');
  if (await saude() && await conferirRota()) { log('PRONTO — Google no servidor, serviço ativo.'); return; }
  console.error('[google] o serviço não respondeu direito depois da troca. Voltando…');
  if (precisaTrocar) { fs.rmSync(RAIZ + '.falhougoogle', { recursive: true, force: true }); fs.renameSync(RAIZ, RAIZ + '.falhougoogle'); fs.renameSync(RAIZ + '.antigo', RAIZ); }
  if (envAntes != null) fs.writeFileSync(ENV_ARQ, envAntes);
  sh('systemctl restart pronta-nuvem');
  console.error('[google] voltei para a versão anterior.' + (precisaTrocar ? ' A pasta que falhou ficou em ' + RAIZ + '.falhougoogle' : ''));
  process.exit(1);
})().catch((e) => parar(e.stack || e.message));
