'use strict';
// MesaPronta — "Entrar com Google" e "Cadastrar com Google" (site mesapronta.net).
// Fica em familia/nuvem/google.js e é chamado pelo orquestrador em dois pontos:
//   rota(req, res, ctx)  -> POST /api/site/google  { credential }   (credential = token ID do Google Identity Services)
//       e-mail já tem conta  -> { ok, conta: true, loja, entrar }   (link de entrada de uso único, igual ao do cadastro)
//       e-mail sem conta     -> { ok, conta: false, nome, email, google }   (google = bilhete de 30 min para o cadastro)
//   doCadastro(b)        -> dentro de /api/site/cadastro: troca o bilhete pelo e-mail confirmado pelo Google
// O token ID é conferido aqui mesmo (assinatura RS256 com as chaves públicas do Google, emissor, Client ID, validade
// e e-mail confirmado). Sem dependências. O Client ID vem de GOOGLE_CLIENT_ID (/etc/pronta-nuvem.env); sem ele a rota
// responde 503 e o site continua só com o formulário.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TESTE = process.env.TESTE_LOCAL === '1';
const JWKS_URL = (TESTE && process.env.GOOGLE_JWKS_URL) || 'https://www.googleapis.com/oauth2/v3/certs';   // outro endereço só em teste local
const EMISSORES = new Set(['accounts.google.com', 'https://accounts.google.com']);
const MIN_BILHETE = 30;
const clientIds = () => String(process.env.GOOGLE_CLIENT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

// segredo próprio para assinar o bilhete do cadastro (gerado uma vez; perder só invalida bilhetes de 30 min)
let SEG = null;
function segredo() {
  if (SEG) return SEG;
  const arq = path.join(process.env.DADOS || '/srv/pronta/dados', 'google-segredo.txt');
  try { SEG = fs.readFileSync(arq, 'utf8').trim(); } catch {}
  if (!SEG || SEG.length < 32) { SEG = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(arq, SEG, { mode: 0o600 }); }
  return SEG;
}
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const hmac = (t) => crypto.createHmac('sha256', segredo()).update(t).digest('base64url');
function iguais(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// ---------- chaves públicas do Google (cache pelo Cache-Control) ----------
let chaves = { mapa: new Map(), ate: 0, buscado: 0 };
async function baixarChaves() {
  const r = await fetch(JWKS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('chaves do Google: HTTP ' + r.status);
  const j = await r.json();
  const mapa = new Map();
  for (const k of j.keys || []) if (k.kid && k.kty === 'RSA') mapa.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
  const idade = Number((String(r.headers.get('cache-control') || '').match(/max-age=(\d+)/) || [])[1]) || 3600;
  chaves = { mapa, ate: Date.now() + Math.min(idade, 86400) * 1000, buscado: Date.now() };
}
async function chave(kid) {
  if (!chaves.mapa.has(kid) || Date.now() > chaves.ate) {
    if (Date.now() - chaves.buscado > 60000 || !chaves.mapa.size) await baixarChaves();
  }
  return chaves.mapa.get(kid) || null;
}

// confere o token ID; devolve { email, nome, sub } ou lança Error com .mensagem para o cliente
async function conferirToken(token) {
  const falha = (m, log) => { const e = new Error(log || m); e.mensagem = m; throw e; };
  const ids = clientIds();
  const partes = String(token || '').split('.');
  if (partes.length !== 3 || partes[0].length > 2000 || partes[1].length > 8000) falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'token mal formado');
  let cab, dados;
  try { cab = b64json(partes[0]); dados = b64json(partes[1]); } catch { falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'token ilegível'); }
  if (cab.alg !== 'RS256' || !cab.kid) falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'alg ' + cab.alg);
  const k = await chave(String(cab.kid));
  if (!k) falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'kid desconhecido');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(partes[0] + '.' + partes[1]), k, Buffer.from(partes[2], 'base64url'));
  if (!ok) falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'assinatura');
  const agora = Date.now() / 1000;
  if (!EMISSORES.has(dados.iss)) falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'iss ' + dados.iss);
  const aud = Array.isArray(dados.aud) ? dados.aud : [dados.aud];
  if (!aud.some(a => ids.includes(a))) falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'aud');
  if (!(Number(dados.exp) > agora - 60)) falha('O acesso com o Google expirou. Toque no botão do Google de novo.', 'exp');
  if (Number(dados.iat) > agora + 300) falha('Não foi possível confirmar sua conta Google. Tente de novo.', 'iat');
  const email = String(dados.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) falha('Sua conta Google não informou um e-mail. Use o formulário.', 'sem email');
  if (dados.email_verified !== true && dados.email_verified !== 'true') falha('O e-mail desta conta Google não está confirmado. Use o formulário.', 'email nao verificado');
  const nome = String(dados.name || [dados.given_name, dados.family_name].filter(Boolean).join(' ') || '').trim().slice(0, 80);
  return { email, nome, sub: String(dados.sub || '').slice(0, 64) };
}

// ---------- bilhete do cadastro (e-mail já confirmado pelo Google) ----------
function bilhete(g) {
  const p = Buffer.from(JSON.stringify({ e: g.email, n: g.nome, s: g.sub, x: Date.now() + MIN_BILHETE * 60000 })).toString('base64url');
  return 'g1.' + p + '.' + hmac('g1.' + p);
}
function lerBilhete(t) {
  const [v, p, sig] = String(t || '').split('.');
  if (v !== 'g1' || !p || !sig || !iguais(sig, hmac('g1.' + p))) return null;
  let d; try { d = b64json(p); } catch { return null; }
  if (!(d.x > Date.now()) || !d.e) return null;
  return { email: d.e, nome: d.n || '', sub: d.s || '' };
}

// dentro de /api/site/cadastro (antes das validações): troca o bilhete pelo e-mail. Devolve { erro } ou null.
function doCadastro(b) {
  if (!b || b.google == null || b.google === '') return null;
  const g = lerBilhete(b.google);
  delete b.google;
  if (!g) return { erro: 'Seu acesso com o Google expirou. Toque em "Continuar com Google" de novo.' };
  b.email = g.email;
  // online: entra com o Google (a senha fica aleatória; dá para criar uma pelo suporte). Computador: a pessoa cria a senha do programa.
  if (String(b.senha || '').length < 8) b.senha = crypto.randomBytes(18).toString('base64url');
  const utm = b.utm && typeof b.utm === 'object' ? b.utm : {};
  b.utm = { ...utm, cadastro: 'google' };
  return null;
}

// ---------- rota POST /api/site/google ----------
async function rota(req, res, ctx) {
  const { dominio, produto, db, json, lerJson, ipDe, bloqueado, falhou, criarEntradaUnica, urlLoja } = ctx;
  const origem = String(req.headers.origin || '');
  const permitidas = [`https://${dominio}`, `https://www.${dominio}`, ...(TESTE ? ['http://localhost:8099', 'http://127.0.0.1:8099'] : [])];
  const cors = permitidas.includes(origem) ? { 'Access-Control-Allow-Origin': origem, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : { Vary: 'Origin' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { ok: false, erro: 'metodo' }, cors);
  if (!clientIds().length) return json(res, 503, { ok: false, erro: 'google_desligado', mensagem: 'O acesso com o Google ainda não está ligado. Use o formulário.' }, cors);
  const ip = ipDe(req);
  if (bloqueado('google:' + ip, 20, 15)) return json(res, 429, { ok: false, erro: 'muitas_tentativas' }, cors);
  falhou('google:' + ip);
  let b; try { b = await lerJson(req); } catch { return json(res, 400, { ok: false, erro: 'dados', mensagem: 'Não foi possível ler o pedido.' }, cors); }
  let g;
  try { g = await conferirToken(b && b.credential); }
  catch (e) { console.log('[google] recusado:', e.message); return json(res, e.mensagem ? 401 : 502, { ok: false, erro: 'google_invalido', mensagem: e.mensagem || 'Não foi possível falar com o Google agora. Use o formulário.' }, cors); }
  // um e-mail = uma conta (online ou do computador): a do e-mail confirmado pelo Google
  const loja = db.prepare('SELECT * FROM lojas WHERE lower(email) = ? AND produto = ? ORDER BY ativo DESC, espelho, id LIMIT 1').get(g.email, produto);
  if (loja) {
    if (!loja.ativo) return json(res, 403, { ok: false, erro: 'suspensa', mensagem: 'Esta conta está suspensa. Fale com o suporte no WhatsApp (11) 98130-8308.' }, cors);
    const base = urlLoja(loja);
    console.log(`[google] entrou: ${loja.slug}`);
    return json(res, 200, { ok: true, conta: true, forma: loja.espelho ? 'computador' : 'online', nome: loja.nome, loja: base, entrar: `${base}/entrar?t=${criarEntradaUnica(loja)}` }, cors);
  }
  return json(res, 200, { ok: true, conta: false, nome: g.nome, email: g.email, google: bilhete(g) }, cors);
}

module.exports = { rota, doCadastro, _conferirToken: conferirToken, _bilhete: bilhete, _lerBilhete: lerBilhete };
