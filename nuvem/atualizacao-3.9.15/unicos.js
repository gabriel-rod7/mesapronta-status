// MesaPronta 3.9.15 — uma conta por CPF/CNPJ e aviso de WhatsApp já cadastrado.
// Chamado no começo de rotasApp() do orquestrador (app.<dominio>), antes do cadastro do site e do app.
//  - CPF/CNPJ que já tem conta (online ou do computador): recusa, mostra o e-mail da conta (mascarado) e manda entrar nela.
//  - WhatsApp que já tem conta: avisa "é isso mesmo?". Passa se a pessoa confirmar (confirmar_whatsapp no site novo,
//    ou mandando o mesmo cadastro de novo em até 15 min, para o site/app antigos que só mostram a mensagem).
//  - Banco: CPF/CNPJ repetidos que já existiam ficam com uma conta só (paga > online > mais antiga); das outras o documento
//    vai para documento_conflito. Depois cria o índice único ux_lojas_documento: o banco não aceita mais repetido.
'use strict';
const { Readable } = require('stream');

module.exports = function ({ db, CFG }) {
  const dig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
  const zapNorm = (v) => { const z = dig(v); return (z.length === 12 || z.length === 13) && z.startsWith('55') ? z.slice(2) : z; };
  const docSql = "replace(replace(replace(replace(replace(replace(coalesce(documento,''),'.',''),'-',''),'/',''),' ',''),'CNPJ',''),'CPF','')";
  const cols = () => db.prepare('PRAGMA table_info(lojas)').all().map(x => x.name);
  const mascara = (e) => { e = String(e || ''); const [u, d] = e.split('@'); if (!d) return ''; return u.slice(0, Math.min(2, u.length)) + '•••@' + d; };
  const fmtDoc = (d) => d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;

  // ---- banco: arruma os repetidos que já existem e cria o índice único ----
  function arrumarBanco() {
    if (!cols().includes('documento_conflito')) db.exec('ALTER TABLE lojas ADD COLUMN documento_conflito TEXT');
    const c = cols(), pagaSql = c.includes('licenca_ate') ? "(licenca_ate IS NOT NULL AND licenca_ate <> '')" : '0';
    const espSql = c.includes('espelho') ? 'espelho' : '0';
    const grupos = db.prepare(`SELECT produto, ${docSql} d, COUNT(*) n FROM lojas WHERE ${docSql} <> '' GROUP BY produto, d HAVING n > 1`).all();
    const arrumadas = [];
    for (const g of grupos) {
      const contas = db.prepare(`SELECT id, slug, ${pagaSql} paga, ${espSql} espelho FROM lojas WHERE produto = ? AND ${docSql} = ? ORDER BY paga DESC, espelho ASC, id ASC`).all(g.produto, g.d);
      const fica = contas[0];
      for (const o of contas.slice(1)) {
        db.prepare('UPDATE lojas SET documento_conflito = documento, documento = NULL WHERE id = ?').run(o.id);
        arrumadas.push(`${o.slug} (fica com ${fica.slug})`);
      }
    }
    if (arrumadas.length) console.log('[cpf-unico] documento repetido tirado de: ' + arrumadas.join(', '));
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_lojas_documento ON lojas (produto, (${docSql})) WHERE documento IS NOT NULL AND documento <> ''`);
    return arrumadas;
  }
  const arrumadas = arrumarBanco();

  const contaDoDocumento = (produto, d) => db.prepare(`SELECT id, slug, nome, email FROM lojas WHERE produto = ? AND ${docSql} = ? ORDER BY id LIMIT 1`).get(produto, d);
  const contaDoEmail = (produto, e) => db.prepare('SELECT id FROM lojas WHERE produto = ? AND email = ? LIMIT 1').get(produto, e);
  function contaDoZap(produto, z) {
    if (z.length < 10) return null;
    for (const l of db.prepare("SELECT id, slug, nome, email, whatsapp FROM lojas WHERE produto = ? AND whatsapp IS NOT NULL AND whatsapp <> '' ORDER BY id").all(produto))
      if (zapNorm(l.whatsapp) === z) return l;
    return null;
  }

  // confirmação do WhatsApp repetido para o site/app antigos: mesmo IP + mesmo número em até 15 min
  const avisados = new Map();
  const ipDe = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  function jaAvisado(req, z) {
    const k = ipDe(req) + '|' + z, t = avisados.get(k), agora = Date.now();
    for (const [kk, tt] of avisados) if (agora - tt > 15 * 60e3) avisados.delete(kk);
    return t && agora - t <= 15 * 60e3;
  }
  const marcarAvisado = (req, z) => avisados.set(ipDe(req) + '|' + z, Date.now());

  function corsSite(req, dominio) {
    const origem = String(req.headers.origin || '');
    const permitidas = [`https://${dominio}`, `https://www.${dominio}`, ...(CFG.teste ? [`http://${dominio}:${CFG.porta}`, 'http://localhost:8099'] : [])];
    return permitidas.includes(origem) ? { 'Access-Control-Allow-Origin': origem, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : { Vary: 'Origin' };
  }
  function responder(res, status, obj, extra) {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
    res.end(JSON.stringify(obj));
  }
  function lerTudo(req, max = 64 * 1024) {
    return new Promise((ok, erro) => {
      const p = []; let n = 0;
      req.on('data', d => { n += d.length; if (n > max) { erro(new Error('grande demais')); req.destroy(); return; } p.push(d); });
      req.on('end', () => ok(Buffer.concat(p))); req.on('error', erro);
    });
  }
  // devolve um "req" novo com o mesmo corpo, para o cadastro original ler normalmente
  function reqDeNovo(req, buf) {
    const r = Readable.from(buf.length ? [buf] : []);
    for (const k of ['headers', 'method', 'url', 'httpVersion', 'rawHeaders', 'socket', 'connection']) r[k] = req[k];
    return r;
  }
  function parse(req, buf) {
    const t = buf.toString('utf8'); if (!t) return {};
    try { return /json/.test(req.headers['content-type'] || '') ? JSON.parse(t) : Object.fromEntries(new URLSearchParams(t)); } catch { return null; }
  }
  const sim = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;

  // true = já respondeu; objeto = req novo para seguir; null = nada a fazer
  async function antes(req, res, dominio, url, produto) {
    const site = url.pathname === '/api/site/cadastro', app = url.pathname === '/api/cadastro';
    if (req.method !== 'POST' || (!site && !app)) return null;
    let buf; try { buf = await lerTudo(req); } catch { return true; }
    const segue = reqDeNovo(req, buf);
    const b = parse(req, buf); if (!b || typeof b !== 'object') return segue;
    if (site && (b.botcheck === true || b.botcheck === 'true' || b.botcheck === 'on')) return segue;
    const cors = site ? corsSite(req, dominio) : {};
    const email = String(b.email || '').trim().toLowerCase();
    const entrar = `https://app.${dominio}/entrar`;

    // 1) CPF/CNPJ: uma conta só (só o site pede documento)
    const d = dig(b.documento);
    if (d.length === 11 || d.length === 14) {
      const c = contaDoDocumento(produto, d);
      if (c) {
        const tipo = d.length === 11 ? 'CPF' : 'CNPJ', em = mascara(c.email);
        console.log(`[cpf-unico] recusado: ${tipo} já é de ${c.slug}`);
        const mensagem = `Este ${tipo} já tem uma conta no MesaPronta${em ? ' (' + em + ')' : ''}. Entre nela em app.${dominio}/entrar. Esqueceu a senha? Fale com o suporte.`;
        return responder(res, 400, { ok: false, erro: 'documento_existe', campo: 'documento', mensagem, conta: c.nome, email: em, entrar }, cors), true;
      }
    }
    // 2) WhatsApp já cadastrado: avisa e pergunta (e-mail repetido continua com a resposta de sempre)
    const z = zapNorm(b.whatsapp);
    if (z.length >= 10 && !(email && contaDoEmail(produto, email))) {
      const c = contaDoZap(produto, z);
      if (c && !sim(b.confirmar_whatsapp) && !jaAvisado(req, z)) {
        marcarAvisado(req, z);
        const em = mascara(c.email);
        const mensagem = `Este WhatsApp já está cadastrado na conta "${c.nome}"${em ? ' (' + em + ')' : ''}. Se é isso mesmo (outra loja sua), ${site ? 'clique em continuar de novo' : 'toque em "Criar minha conta grátis" de novo'}. Se for a mesma loja, entre na sua conta em app.${dominio}/entrar.`;
        console.log(`[cpf-unico] aviso: WhatsApp já é de ${c.slug}`);
        if (site) return responder(res, 400, { ok: false, erro: 'whatsapp_existe', campo: 'whatsapp', mensagem, conta: c.nome, email: em, entrar }, cors), true;
        return responder(res, 409, { erro: mensagem, whatsapp_existe: true, conta: c.nome, email: em, entrar }), true;
      }
      if (c) console.log(`[cpf-unico] WhatsApp de ${c.slug} confirmado para conta nova`);
    }
    return segue;
  }

  return { antes, arrumadas, fmtDoc };
};
