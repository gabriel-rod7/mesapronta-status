'use strict';
// MesaPronta 3.12.0 no servidor: caixa em um passo, Início com um roteiro só, cardápio online no ar,
// "Peça também" medido, clientes que pararam de pedir, cardápio online ligado em loja nova.
// Uso: node aplicar.js <commit> [--com-programa] [--ensaio] [--raiz <pasta familia>]
// - Trabalha numa cópia (familia.novo312), confere cada remendo (tem que achar o trecho exatamente 1 vez),
//   testa um sistema de verdade numa porta livre e só então troca. Se algo der errado depois de trocar, volta sozinho.
// - --ensaio: faz tudo (cópia, remendos, teste) e não troca nada. Rode primeiro.
// - Idempotente: rodar de novo não muda nada.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto'), http = require('node:http'), os = require('node:os');

const args = process.argv.slice(2);
const COMMIT = args.find(a => /^[0-9a-f]{7,40}$/.test(a)) || 'main';
const ENSAIO = args.includes('--ensaio');
const COM_PROGRAMA = args.includes('--com-programa');
const iRaiz = args.indexOf('--raiz');
const RAIZ = iRaiz >= 0 ? path.resolve(args[iRaiz + 1]) : '/srv/pronta/app/familia';
const AQUI = __dirname;
const VERSAO = '3.12.0';
const BACKUPS = process.env.PRONTA_BACKUPS || '/srv/pronta/backups';
const MANIFESTO = process.env.PRONTA_MANIFESTO || '/srv/pronta/dados/atualizacao.json';
const EXE = { nome: `MesaPronta-${VERSAO}.exe.gz`, sha256: 'aeaef978279460502f4665deee0c711d8ed6353d35adcbffa1320afcecdd04e3', bytes: 96182272 };

const log = (...a) => console.log('[3.12.0]', ...a);
const parar = (msg) => { console.error('\n[3.12.0] PAROU: ' + msg + '\nNada foi trocado no servidor.'); process.exit(1); };
class RemendoErro extends Error {}
const falhar = (msg) => { throw new RemendoErro(msg); };   // dentro de remendar(): as falhas são juntadas e só então o script para
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sh = (c, o = {}) => cp.execSync(c, { stdio: ['ignore', 'pipe', 'pipe'], ...o }).toString();
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------- arquivos de tela ----------------
// sha da 3.11.0 (como está no ar) -> arquivo novo (no publico.tgz). null = arquivo novo.
const TELAS = {
  'index.html': '098ec1921e9a2872',
  'js/caixa.js': 'd768fa9027426441',
  'js/comum.js': '785e6e8f142a8086',
  'js/guia.js': 'e072bcd63188a8d8',
  'js/online.js': 'a527999cad88d8fd',
  'cardapio-online.html': '90f3a6957cc16a86',
  'css/app.css': 'c6fc839977d6a607',
  'css/ux312.css': null,
};
const MARCA = '// ---- 3.12.0: caixa rápido, cardápio online no ar, clientes parados ----';

function listarJs(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    if (n.name === 'node_modules' || n.name.startsWith('.')) continue;
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...listarJs(p)); else if (n.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const perto = (t, i, antes = 120, depois = 160) => '…' + t.slice(Math.max(0, i - antes), i + depois).replace(/\s+/g, ' ') + '…';

// SQL dos remendos (iguais no programa do computador)
const SQL_TOTAL_ONLINE = "SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM pedidos WHERE origem = 'online' AND status = 'fechado'";
const SQL_SUG_MES = "SELECT COUNT(*) n, COALESCE(SUM((i.preco_unit + i.adicionais_total) * i.qtd),0) t FROM itens i JOIN pedidos p ON p.id = i.pedido_id WHERE i.sugestao = 1 AND i.cancelado = 0 AND p.status != 'cancelado' AND substr(p.aberto_em,1,7) = strftime('%Y-%m','now','localtime')";
const SQL_PARADOS = "SELECT c.id, c.nome, c.telefone, c.pedidos, c.ultimo_pedido_em, (SELECT COALESCE(SUM(total),0) FROM pedidos WHERE cliente_id = c.id AND status = 'fechado') total, (SELECT i.nome FROM itens i JOIN pedidos p ON p.id = i.pedido_id WHERE p.cliente_id = c.id AND i.cancelado = 0 GROUP BY i.nome ORDER BY SUM(i.qtd) DESC LIMIT 1) favorito FROM clientes c WHERE COALESCE(c.telefone,'') != '' AND c.pedidos >= 1 AND c.ultimo_pedido_em IS NOT NULL AND c.ultimo_pedido_em < datetime('now','localtime', ?) ORDER BY total DESC LIMIT 60";
const SQL_PARADOS_N = "SELECT COUNT(*) n FROM clientes WHERE COALESCE(telefone,'') != '' AND pedidos >= 1 AND ultimo_pedido_em < datetime('now','localtime','-30 days')";

// aplica os remendos no código do servidor (texto -> texto); devolve { usados }
function remendar(fontes) {
  const usados = new Set();
  const achar = (re, esperado, nome) => {
    const res = [];
    for (const [f, t] of Object.entries(fontes)) { const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); let m; while ((m = r.exec(t))) res.push({ f, m, i: m.index }); }
    if (res.length !== esperado) {
      console.error(`\n[3.12.0] Remendo "${nome}": esperava ${esperado}, achei ${res.length}.`);
      for (const x of res.slice(0, 5)) console.error('   ' + path.basename(x.f) + ': ' + perto(fontes[x.f], x.i));
      falhar(`o código do servidor não está como esperado (remendo "${nome}"). Mande este texto para o suporte.`);
    }
    return res;
  };
  const trocar = (f, i, len, novo) => { fontes[f] = fontes[f].slice(0, i) + novo + fontes[f].slice(i + len); usados.add(f); };
  const dbAntes = (t, i, nome, alcance = 6000) => { const a = t.slice(Math.max(0, i - alcance), i); const ms = [...a.matchAll(/([\w$]+)\.prepare\(/g)]; if (!ms.length) falhar(`não achei a variável do banco (remendo "${nome}").`); return ms[ms.length - 1][1]; };

  if (Object.values(fontes).some(t => t.includes(MARCA))) return { jaAplicado: true, usados };
  const falhas = [], nl2 = '\n';
  const tentar = (nome, fn) => { try { fn(); } catch (e) { if (!(e instanceof RemendoErro)) throw e; falhas.push(nome + ') ' + e.message); } };   // confere todos os remendos antes de parar

  // A) configurações novas (entram na lista aceita pelo PUT /api/config) e padrão das observações gerais
  tentar('A', () => {
  for (const x of achar(/(obs_rapidas_gerais\s*:\s*)(['"])Sem cebola;Sem tomate;Sem gelo;Bem passado;Mal passado;Para viagem\2(\s*,?)/, 1, 'configurações')) {
    const q = x.m[2];
    trocar(x.f, x.i, x.m[0].length, `${x.m[1]}${q}Para viagem;Sem talheres${q}, toque_direto: ${q}1${q}, balcao_receber_junto: ${q}1${q}, balcao_f3_direto: ${q}1${q}, online_divulgado: ${q}0${q}${x.m[3]}`);
  }
  });
  // B) exemplos de um sistema novo: observações por tipo de produto
  tentar('B', () => {
  for (const x of achar(/(['"])Sem cebola;Sem tomate;Sem maionese;Ponto da carne bem passado\1/, 1, 'exemplo lanches')) trocar(x.f, x.i, x.m[0].length, `${x.m[1]}Sem cebola;Sem tomate;Sem maionese;Bem passado;Mal passado${x.m[1]}`);
  for (const x of achar(/(['"])Sem salada;Sem feij(?:ão|\\xE3o);Arroz (?:à|\\xE0) parte\1/, 1, 'exemplo pratos')) trocar(x.f, x.i, x.m[0].length, `${x.m[1]}Sem salada;Sem feijão;Arroz à parte;Bem passado${x.m[1]}`);
  for (const x of achar(/(['"])Sem gelo;Com lim(?:ão|\\xE3o);Bem gelada\1/, 1, 'exemplo bebidas')) trocar(x.f, x.i, x.m[0].length, `${x.m[1]}Sem gelo;Com limão;Bem gelada;Com canudo${x.m[1]}`);
  });
  // C) coluna itens.sugestao
  tentar('C', () => {
  for (const x of achar(/([\w$]+)\(\s*(['"])itens\2\s*,\s*(['"])pago_qtd\3\s*,\s*(['"])INTEGER NOT NULL DEFAULT 0\4\s*\)\s*;?/, 1, 'coluna sugestao')) {
    trocar(x.f, x.i, x.m[0].length, x.m[0] + ` ${x.m[1]}('itens', 'sugestao', 'INTEGER NOT NULL DEFAULT 0');`);
  }
  });
  // D) ao gravar um item do pedido, guarda se veio do "Peça também"
  tentar('D', () => {
  {
    const [x] = achar(/INSERT INTO itens \(pedido_id, produto_id, produto2_id, nome, qtd, preco_unit, adicionais, adicionais_total, obs, setor_id, lote, status, usuario_id, criado_em, tamanho, custo_unit, origem, profissional_id, entregue_em\)/, 1, 'gravar item');
    const t = fontes[x.f];
    const antes = t.slice(Math.max(0, x.i - 400), x.i);
    const ma = antes.match(/([\w$]+)\s*=\s*([\w$]+)\.prepare\(\s*[`'"]\s*$/);
    if (!ma) { console.error('   ' + perto(t, x.i, 300, 40)); falhar('não achei "variavel = banco.prepare(" antes do INSERT dos itens (remendo "gravar item").'); }
    const idVar = ma[1], dbVar = ma[2];
    const loops = [...t.slice(Math.max(0, x.i - 12000), x.i).matchAll(/for\s*\(\s*(?:const|let|var)\s+(?:\[\s*)?([\w$]+)[^)]*?\bof\b/g)];
    if (!loops.length) falhar('não achei o "for ... of" dos itens (remendo "gravar item").');
    const itemVar = loops[loops.length - 1][1];
    const j = t.indexOf('.lastInsertRowid', x.i);
    if (j < 0 || j - x.i > 3000) falhar('não achei o .lastInsertRowid depois do INSERT dos itens (remendo "gravar item").');
    let k = j + '.lastInsertRowid'.length;
    while (k < t.length && /[\s)\]]/.test(t[k])) k++;
    if (t[k] !== ';') { console.error('   ' + perto(t, k, 80, 80)); falhar('o INSERT dos itens não termina com ";" como esperado (remendo "gravar item").'); }
    trocar(x.f, k + 1, 0, ` if (${itemVar}.sugestao) ${dbVar}.prepare('UPDATE itens SET sugestao = 1 WHERE id = ?').run(${idVar});`);
  }
  });
  // E) pedido do cardápio online: o item da sacola leva a marca
  tentar('E', () => {
  for (const x of achar(/opcoes\s*:\s*Array\.isArray\(\s*([\w$]+)\.opcoes\s*\)\s*\?\s*\1\.opcoes\.slice\(\s*0\s*,\s*120\s*\)\s*\.filter\(/, 1, 'itens online')) {   // só o delivery (o totem não tem .filter)
    trocar(x.f, x.i, 0, `sugestao: ${x.m[1]}.sugestao ? 1 : 0, `);
  }
  });
  // F) resumo do cardápio online: total desde o começo e o "Peça também" do mês
  tentar('F', () => {
  for (const x of achar(/produtos\s*:\s*([\w$]+)\.prepare\(\s*(['"`])SELECT COUNT\(\*\) n FROM produtos p JOIN categorias c ON c\.id = p\.categoria_id WHERE p\.ativo = 1 AND c\.ativo = 1 AND c\.no_cardapio = 1\2\s*\)\.get\(\)\.n/, 1, 'resumo online')) {
    const db = x.m[1];
    trocar(x.f, x.i, 0, `total: ${db}.prepare(${JSON.stringify(SQL_TOTAL_ONLINE)}).get(), sugestoes_mes: ${db}.prepare(${JSON.stringify(SQL_SUG_MES)}).get(), `);
  }
  });
  // G) relatórios: pedidos online no período e venda sugestiva
  tentar('G', () => {
  {
    const [x] = achar(/([\w$]+)\s*=\s*([\w$]+)\.prepare\(\s*`SELECT c\.nome, c\.telefone, COUNT\(\*\) pedidos, SUM\(p\.total\) total FROM pedidos p JOIN clientes c ON c\.id = p\.cliente_id WHERE \$\{([\w$]+)\} GROUP BY c\.id ORDER BY total DESC LIMIT 10`\s*\)\.all\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)/, 1, 'relatórios');
    const [, , DB, F, DE, ATE] = x.m;
    const t = fontes[x.f];
    let k = x.i + x.m[0].length; while (k < t.length && /\s/.test(t[k])) k++;
    const sep = t[k];
    const q1 = `\`SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM pedidos p WHERE p.origem = 'online' AND \${${F}}\``;
    const q2 = `\`SELECT COUNT(*) n, COALESCE(SUM((i.preco_unit + i.adicionais_total) * i.qtd),0) t FROM itens i JOIN pedidos p ON p.id = i.pedido_id WHERE i.sugestao = 1 AND i.cancelado = 0 AND \${${F}}\``;
    let novo;
    if (sep === ',') novo = `__mpOnline = ${DB}.prepare(${q1}).get(${DE}, ${ATE}), __mpSug = ${DB}.prepare(${q2}).get(${DE}, ${ATE}), `;
    else if (sep === ';') novo = ` const __mpOnline = ${DB}.prepare(${q1}).get(${DE}, ${ATE}); const __mpSug = ${DB}.prepare(${q2}).get(${DE}, ${ATE});`;
    else { console.error('   ' + perto(t, k, 80, 80)); falhar('não entendi o que vem depois da consulta dos melhores clientes (remendo "relatórios").'); }
    trocar(x.f, k + 1, 0, novo);
    const t2 = fontes[x.f];
    const re = /melhoresClientes\s*(?::\s*[\w$]+)?\s*,/g; re.lastIndex = k + 1 + novo.length;
    const mr = re.exec(t2);
    if (!mr || mr.index - k > 4000) falhar('não achei "melhoresClientes" no retorno dos relatórios (remendo "relatórios").');
    trocar(x.f, mr.index, 0, 'online: __mpOnline, sugestoes: __mpSug, ');
  }
  });
  // H) rota nova: clientes que pararam de pedir (ao lado da busca de clientes)
  tentar('H', () => {
  {
    const [x] = achar(/([\w$]+)\(\s*(['"])GET\2\s*,\s*(['"])\/api\/clientes\/busca\3\s*,\s*(?:async\s*)?\(\s*([\w$]+)\s*[^)]*\)\s*=>\s*\{?\s*(?:return\s*)?\(?\s*([\w$]+)\(\s*\4\s*,\s*(['"])caixa\6\s*\)/, 1, 'rota parados');
    const rota = x.m[1], req = x.m[4], auth = x.m[5];
    const depois = fontes[x.f].slice(x.i, x.i + 900);
    const mdb = depois.match(/([\w$]+)\.prepare\(/);
    if (!mdb) falhar('não achei o banco na busca de clientes (remendo "rota parados").');
    const db = mdb[1];
    trocar(x.f, x.i, 0, `${rota}('GET', '/api/clientes/parados', (${req}, __b, __p, __q) => { ${auth}(${req}, 'caixa'); const dias = Math.max(7, Math.min(365, Number(__q && __q.dias) || 30)); return ${db}.prepare(${JSON.stringify(SQL_PARADOS)}).all('-' + dias + ' days'); });\n`);
  }
  });
  // I) Início: quantos clientes sumiram
  tentar('I', () => {
  {
    const [x] = achar(/(primeirosPassos\s*(?::\s*[\w$]+)?\s*,)(\s*licenca\s*:)/, 1, 'início');
    const db = dbAntes(fontes[x.f], x.i, 'início');
    trocar(x.f, x.i + x.m[1].length, 0, ` clientes_parados: (() => { try { return ${db}.prepare(${JSON.stringify(SQL_PARADOS_N)}).get().n; } catch (e) { return 0; } })(),`);
  }
  });
  // J) loja nova já nasce com o cardápio online ligado (logo depois do seed_max_prod, no seed de exemplo)
  tentar('J', () => {
  {
    const [x] = achar(/([\w$]+)\.prepare\(\s*(['"])INSERT OR REPLACE INTO config \(chave, valor\) VALUES \(\?, \?\)\2\s*\)\.run\(\s*(['"])seed_max_prod\3/, 1, 'cardápio online ligado');
    const t = fontes[x.f]; const db = x.m[1];
    // anda até o fim da chamada .run(...), fechando parênteses e pulando o que está entre aspas
    let k = x.i + x.m[0].length, prof = 1, q = null;
    for (; k < t.length && prof > 0; k++) { const ch = t[k]; if (q) { if (ch === '\\') k++; else if (ch === q) q = null; } else if (ch === "'" || ch === '"' || ch === '`') q = ch; else if (ch === '(') prof++; else if (ch === ')') prof--; }
    while (k < t.length && /\s/.test(t[k])) k++;
    const dep = t[k];
    const stmt = `${db}.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('online_ativo', '1')").run()`;
    if (dep === ';' || dep === ',') trocar(x.f, k + 1, 0, ' ' + stmt + dep);   // vira a instrução seguinte (ou o próximo item da sequência com vírgula, no minificado)
    else if (dep === '}') trocar(x.f, k, 0, '; ' + stmt + ' ');   // última instrução do bloco (no minificado: "...run(...)})")
    else { console.error('   ' + perto(t, k, 120, 60)); falhar('não entendi o fim da instrução do seed_max_prod (remendo "cardápio online ligado").'); }
  }
  });
  if (falhas.length) parar(`${falhas.length} remendo(s) não bateram com o código do servidor:` + nl2 + falhas.map(f => '  - ' + f).join(nl2) + nl2 + 'Mande este texto para o suporte.');
  for (const f of usados) fontes[f] += `\n${MARCA}\n`;
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
  const dados = tmpDir('mp312-'), porta = 39000 + Math.floor(Math.random() * 900);
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
    if (process.env.MP_CHAVE_TESTE) { const at = await pedir(porta, 'POST', '/api/licenca/ativar', { chave: process.env.MP_CHAVE_TESTE }, tk); conf(at.status === 200, 'chave de teste (ensaio no Windows) ' + at.status); }   // só no ensaio fora da VPS: lá o sistema de teste nasce em período de teste
    const cfg0 = (await pedir(porta, 'GET', '/api/config', null, tk)).json || {};
    conf(cfg0.online_ativo === '1', 'cardápio online já ligado no sistema novo (online_ativo=' + cfg0.online_ativo + ')');
    conf(cfg0.toque_direto === '1', 'configuração toque_direto com padrão 1');
    const r0 = await pedir(porta, 'PUT', '/api/config', { toque_direto: '0', balcao_f3_direto: '0', online_divulgado: '1' }, tk);
    conf(r0.status === 200, 'PUT /api/config aceita as chaves novas');
    const cfg1 = (await pedir(porta, 'GET', '/api/config', null, tk)).json || {};
    conf(cfg1.toque_direto === '0' && cfg1.online_divulgado === '1', 'chaves novas gravadas');
    await pedir(porta, 'PUT', '/api/config', { toque_direto: '1', balcao_f3_direto: '1' }, tk);
    const res = (await pedir(porta, 'GET', '/api/online/resumo', null, tk)).json || {};
    conf(res.total && typeof res.total.n === 'number', 'resumo online com total');
    conf(res.sugestoes_mes && typeof res.sugestoes_mes.n === 'number', 'resumo online com sugestoes_mes');
    const par = await pedir(porta, 'GET', '/api/clientes/parados?dias=30', null, tk);
    conf(par.status === 200 && Array.isArray(par.json), 'rota /api/clientes/parados ' + par.status);
    const ini = (await pedir(porta, 'GET', '/api/inicio', null, tk)).json || {};
    conf(typeof ini.clientes_parados === 'number', 'início com clientes_parados');
    const rel = (await pedir(porta, 'GET', '/api/relatorios?de=2000-01-01&ate=2099-12-31', null, tk)).json || {};
    conf(rel.online && typeof rel.online.n === 'number' && rel.sugestoes && typeof rel.sugestoes.n === 'number', 'relatórios com online e sugestoes');
    // pedido online com item vindo do "Peça também"
    await pedir(porta, 'PUT', '/api/config', { online_horarios: JSON.stringify(Array.from({ length: 7 }, () => ({ aberto: true, de: '00:00', ate: '23:59' }))), online_pagamentos: 'dinheiro', online_retirada: '1', online_entrega: '1', online_pausado: '0' }, tk);
    const card = (await pedir(porta, 'GET', '/api/cardapio', null, tk)).json || { produtos: [] };
    const prod = (card.produtos || []).find(x => !(x.tamanhos || []).length && !x.escolha && !x.por_quilo) || (card.produtos || [])[0];
    if (prod) {
      const ped = await pedir(porta, 'POST', '/api/publico/delivery', { modo: 'retirada', cliente: { nome: 'Teste 312', telefone: '11999990312' }, pagamento: 'dinheiro', itens: [{ produto_id: prod.id, qtd: 1, adicionais: [], opcoes: [], sugestao: 1 }] });
      conf(ped.status === 200, 'pedido online de teste ' + ped.status + ' ' + JSON.stringify(ped.json).slice(0, 160));
      const res2 = (await pedir(porta, 'GET', '/api/online/resumo', null, tk)).json || {};
      conf(res2.sugestoes_mes && res2.sugestoes_mes.n === 1, 'item marcado como "Peça também" (coluna sugestao) ' + JSON.stringify(res2.sugestoes_mes));
    } else erros.push('sem produto para testar o pedido online');
    for (const pg of ['/', '/css/ux312.css', '/js/caixa.js', '/js/guia.js', '/cardapio-online']) { const r = await pedir(porta, 'GET', pg); conf(r.status === 200, 'abre ' + pg); }
    const idx = await pedir(porta, 'GET', '/'); conf(String(idx.json).includes('ux312.css'), 'index com o ux312.css');
    const cx = await pedir(porta, 'GET', '/js/caixa.js'); conf(String(cx.json).includes('receber-enviar') && String(cx.json).includes('clientesParados'), 'caixa.js da 3.12');
  } finally {
    p.kill('SIGTERM'); await esperar(600);
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
  const telasDir = tmpDir('mp312-telas-');
  try { sh(`tar xzf ${JSON.stringify(pacoteTelas)} -C ${JSON.stringify(telasDir)}`); }
  catch (e) { if (process.platform !== 'win32') throw e; sh(`tar --force-local -xzf ${JSON.stringify(pacoteTelas)} -C ${JSON.stringify(telasDir)}`); }   // ensaio no Windows (tar do Git lê "C:" como servidor)

  // 1) confere o que está no ar
  const pastasFonte = [path.join(RAIZ, 'base', 'src'), path.join(RAIZ, 'produtos', 'restaurante')].filter(d => fs.existsSync(d));   // o exemplo (seed) do restaurante fica em produtos/restaurante/produto.js
  const fontesVivas = Object.fromEntries(pastasFonte.flatMap(d => listarJs(d)).map(f => [f, fs.readFileSync(f, 'utf8')]));
  const versaoArq = Object.keys(fontesVivas).find(f => path.basename(f) === 'versao.js');
  const versaoAtual = versaoArq ? (fontesVivas[versaoArq].match(/['"](\d+\.\d+\.\d+)['"]/) || [])[1] : null;
  log('versão no servidor:', versaoAtual || '(não achei)');
  const telas = [];
  for (const [rel, curto] of Object.entries(TELAS)) {
    const novo = fs.readFileSync(path.join(telasDir, rel));
    const alvo = path.join(publico, rel);
    const atual = fs.existsSync(alvo) ? fs.readFileSync(alvo) : null;
    if (atual && sha(atual) === sha(novo)) continue;
    if (curto && (!atual || !sha(atual).startsWith(curto))) parar(`a tela ${rel} do servidor não é a da 3.11.0 (sha ${atual ? sha(atual).slice(0, 16) : 'sem arquivo'}).`);
    telas.push([rel, novo]);
  }
  // 2) remenda numa cópia em memória
  const fontes = { ...fontesVivas };
  const r = remendar(fontes);
  if (versaoArq && versaoAtual !== VERSAO) { fontes[versaoArq] = fontes[versaoArq].replace(/(['"])\d+\.\d+\.\d+\1/, `'${VERSAO}'`); r.usados.add(versaoArq); }
  if (!versaoArq) for (const [f, t] of Object.entries(fontes)) if (/exports\s*=\s*['"]3\.11\.0['"]/.test(t)) { fontes[f] = t.replace(/(exports\s*=\s*)(['"])3\.11\.0\2/, `$1$2${VERSAO}$2`); r.usados.add(f); }
  if (r.jaAplicado && !telas.length && versaoAtual === VERSAO) log(`o código e as telas já estão na ${VERSAO}.`);
  else log(`remendos ok em ${[...r.usados].map(f => path.relative(RAIZ, f)).join(', ') || '(nenhum)'}; telas novas: ${telas.map(t => t[0]).join(', ') || '(nenhuma)'}`);

  const precisaTrocar = r.usados.size || telas.length;
  if (precisaTrocar) {
    // 3) monta a cópia nova
    const nova = RAIZ + '.novo312';
    fs.rmSync(nova, { recursive: true, force: true });
    fs.cpSync(RAIZ, nova, { recursive: true });
    for (const f of r.usados) {
      const destino = path.join(nova, path.relative(RAIZ, f));
      fs.writeFileSync(destino, fontes[f]);
      try { sh(`${JSON.stringify(process.execPath)} --check ${JSON.stringify(destino)}`); } catch (e) { parar('erro de sintaxe em ' + path.relative(RAIZ, f) + ': ' + (e.stderr || e.message)); }
    }
    for (const [rel, novo] of telas) { const d = path.join(nova, 'base', 'public', rel); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, novo); }
    try { const st = fs.statSync(RAIZ); if (process.platform !== 'win32') sh(`chown -R ${st.uid}:${st.gid} ${JSON.stringify(nova)}`); } catch {}
    await autoteste(nova);
    if (ENSAIO) { log('ENSAIO: cópia nova pronta e testada em', nova, '(não troquei nada)'); return; }
    // 4) backup e troca
    fs.mkdirSync(BACKUPS, { recursive: true });
    const bk = path.join(BACKUPS, `antes-${VERSAO}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.tgz`);
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
    const raiz = JSON.parse(manifestoAntes);
    log('manifesto antes:', JSON.stringify(raiz));
    const m = raiz.restaurante && typeof raiz.restaurante === 'object' ? raiz.restaurante : raiz;   // formato real no servidor: {"restaurante":{versao,url,sha256,tamanho}}
    const chaves = Object.keys(m);
    const kVer = chaves.find(k => /^vers/.test(k)), kUrl = chaves.find(k => /url/i.test(k)), kSha = chaves.find(k => /sha/i.test(k)), kTam = chaves.find(k => /^(tamanho|bytes|size)$/i.test(k));
    if (!kVer || !kUrl || !kSha) parar('o manifesto não tem versão/url/sha como esperado; não mexi nele.');
    const url = `https://raw.githubusercontent.com/gabriel-rod7/mesapronta-status/${COMMIT}/download/${EXE.nome}`;
    const tmp = path.join(os.tmpdir(), EXE.nome);
    sh(`curl -fsSL -o ${JSON.stringify(tmp)} ${url}`);
    const exe = cp.execSync(`gunzip -c ${JSON.stringify(tmp)}`, { maxBuffer: 300 * 1024 * 1024 });
    fs.rmSync(tmp, { force: true });
    if (sha(exe) !== EXE.sha256 || exe.length !== EXE.bytes) parar(`o .exe baixado do GitHub não confere (sha ${sha(exe).slice(0, 16)}, ${exe.length} bytes). O código já foi trocado, mas o manifesto não.`);
    fs.copyFileSync(MANIFESTO, MANIFESTO + `.antes-${VERSAO}`);
    m[kVer] = VERSAO; m[kUrl] = url; m[kSha] = EXE.sha256; if (kTam) m[kTam] = EXE.bytes;
    fs.writeFileSync(MANIFESTO, JSON.stringify(raiz));
    log('manifesto agora:', JSON.stringify(raiz));
  }
  if (!precisaTrocar && !COM_PROGRAMA) { log('nada a fazer.'); return; }
  if (ENSAIO) return;
  // 6) reinicia e confere; se não subir, volta
  sh('systemctl restart pronta-nuvem');
  if (await saude()) { log(`PRONTO — servidor na ${VERSAO}, serviço ativo.`); return; }
  console.error(`[${VERSAO}] o serviço não respondeu depois da troca. Voltando…`);
  if (precisaTrocar) { fs.renameSync(RAIZ, RAIZ + '.falhou312'); fs.renameSync(RAIZ + '.antigo', RAIZ); }
  if (manifestoAntes) fs.writeFileSync(MANIFESTO, manifestoAntes);
  sh('systemctl restart pronta-nuvem');
  console.error(`[${VERSAO}] voltei para a versão anterior. A pasta que falhou ficou em ` + RAIZ + '.falhou312');
  process.exit(1);
})().catch((e) => parar(e.stack || e.message));
