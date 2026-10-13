// Função serverless que lê a planilha "Controle de devoluções - TF Imports" direto do Google Sheets
// (aba de devoluções, baixada em CSV pelo link de compartilhamento) e devolve as linhas já organizadas
// por plataforma/conta. Não grava nada: quem grava é o navegador, juntando com o que já existe (nunca apaga).
//
// GET /api/ecom-planilha?parte=0  -> { total, partes, parte, regs:[...], avisos:[...] }
//
// A planilha é lida pelo NOME da coluna (Data, Loja, Pedido, SKU...), então mudar a ordem não quebra nada.
// Pode trocar a planilha sem mexer no código: variáveis ECOM_PLANILHA_ID e ECOM_PLANILHA_GID no Vercel.

const PLANILHA_ID = process.env.ECOM_PLANILHA_ID || '1IFiYngD0qzr8ZbPgBh0fuz6k2EHulviHhbIyD-es8vs';
const PLANILHA_GID = process.env.ECOM_PLANILHA_GID || '1922110461';
const POR_PARTE = 4000;

let cache = null; // { em, regs, avisos } — reaproveita por 2 min entre as partes

// ---------- CSV (aceita aspas, vírgula e quebra de linha dentro da célula) ----------
function lerCSV(txt) {
  const linhas = []; let linha = []; let cel = ''; let aspas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) {
      if (c === '"') { if (txt[i + 1] === '"') { cel += '"'; i++; } else aspas = false; }
      else cel += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(cel); cel = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      linha.push(cel); linhas.push(linha); linha = []; cel = '';
    } else cel += c;
  }
  if (cel !== '' || linha.length) { linha.push(cel); linhas.push(linha); }
  return linhas;
}

const t = (v) => String(v == null ? '' : v).trim();
const semAcento = (s) => t(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function num(v) {
  let s = t(v).replace(/R\$|\s/g, '');
  if (!s || s === '-') return 0;
  const neg = /^-/.test(s) || /-$/.test(s);
  s = s.replace(/-/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? (neg ? -n : n) : 0;
}
// Dinheiro: ignora valores absurdos (ex.: nº de pedido colado na coluna de valor).
function dinheiro(v) { const n = num(v); return Math.abs(n) > 1000000 ? 0 : n; }

// Data da planilha -> AAAA-MM-DD. Corrige os erros de digitação comuns (barra dupla, ano 0225).
function data(v) {
  let s = t(v).replace(/\/+/g, '/').replace(/\s.*$/, '');
  let d, m, a;
  let x = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (x) { d = +x[1]; m = +x[2]; a = +x[3]; }
  else if ((x = s.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/))) { a = +x[1]; m = +x[2]; d = +x[3]; }
  else return '';
  if (a < 100) a += 2000;
  else if (a < 1000) a = 2000 + (a % 100);           // 0225 -> 2025
  const anoAtual = new Date().getFullYear();
  if (a < 2018 || a > anoAtual + 1 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Loja da planilha -> plataforma + conta. Dropship = lojas de terceiros.
const DROP = [
  [/tudo\s*eletro/, 'TUDO ELETRO'], [/\bmsl\b/, 'MSL'], [/\bjry\b/, 'JRY'], [/\bstg\b/, 'STG'],
  [/multfifa|multifa/, 'MULTFIFA'], [/goias/, 'GOIAS'],
];
function loja(nome, pedido) {
  const s = semAcento(nome);
  const canal = /^20\d{14}$/.test(pedido) ? 'ml' : /^\d{6}[A-Z0-9]{8}$/i.test(pedido) ? 'shopee' : '';
  for (const [re, conta] of DROP) if (re.test(s)) return { plat: 'drop', conta, canal: canal || (/shopee/.test(s) ? 'shopee' : /^ml\b|mercado/.test(s) ? 'ml' : '') };
  let plat = '';
  if (/^ml\b|mercado\s*livre/.test(s)) plat = 'ml';
  else if (/shopee/.test(s) || /^lp\b/.test(s)) plat = 'shopee';
  else if (/amazon/.test(s)) plat = 'amazon';
  else if (/tik\s*tok/.test(s)) plat = 'tiktok';
  else if (/magalu|magazine\s*luiza/.test(s)) plat = 'magalu';
  if (!plat) return { plat: 'outros', conta: t(nome).toUpperCase() || 'SEM LOJA', canal };
  let resto = s.replace(/^ml\b|mercado\s*livre|shopee|amazon|tik\s*tok|magalu/g, '').replace(/\b(parts|prime|future|store)\b/g, '').trim();
  let conta = 'SEM CONTA';
  if (/phg/.test(resto)) conta = 'PHG';
  else if (/bps/.test(resto)) conta = 'BPS';
  else if (/lims/.test(resto)) conta = 'LIMS';
  else if (/qvari/.test(resto)) conta = 'QVARI';
  else if (/mil+s/.test(resto)) conta = plat === 'ml' ? 'MILLS' : 'MILS';
  else if (/^lp\b/.test(s) || /\blp\b/.test(resto)) conta = 'LP';
  else if (resto) conta = resto.toUpperCase();
  return { plat, conta, canal: canal || plat };
}

function categoria(v) {
  const s = t(v).toUpperCase().replace(/\s+/g, ' ');
  return s.replace(/\bBARRAS\b/g, 'BARRA').replace(/\bIMPORTADAS\b/g, 'IMPORTADA');
}

async function baixarELer() {
  if (cache && Date.now() - cache.em < 120000) return cache;
  const url = `https://docs.google.com/spreadsheets/d/${PLANILHA_ID}/export?format=csv&gid=${PLANILHA_GID}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`O Google não liberou a planilha (erro ${r.status}). Confira se o compartilhamento está como "Qualquer pessoa com o link".`);
  const txt = await r.text();
  if (/^\s*<!DOCTYPE html|<html/i.test(txt.slice(0, 200))) throw new Error('O Google pediu login para abrir a planilha. Deixe o compartilhamento como "Qualquer pessoa com o link".');
  const linhas = lerCSV(txt);
  const cab = (linhas.shift() || []).map(semAcento);
  const col = (re) => cab.findIndex((h) => re.test(h));
  const C = {
    data: col(/^data$/), cliente: col(/^cliente/), loja: col(/^loja/), frete: col(/^tipo de frete/), pedido: col(/^pedido/),
    dataCompra: col(/^data da compra/), erro: col(/^erro nosso/), sku: col(/^sku/), qtd: col(/^qtd|^quantidade/), valor: col(/^valor total/),
    reclamacao: col(/^reclamacao/), motivoContato: col(/^motivo do contato/), estadoProduto: col(/^estado do produto/), mediacao: col(/^mediacao/),
    status: col(/^status$/), reputacao: col(/^reputacao/), destino: col(/^destino/), ganho: col(/^valor ganho\/perdido$/), ganhoML: col(/^valor ganho\/perdido ml/),
    conferencia: col(/^conferencia/), obs: col(/^obs/), categoria: col(/^categoria/),
  };
  const faltando = ['data', 'loja', 'pedido', 'sku'].filter((k) => C[k] < 0);
  if (faltando.length) throw new Error('Não achei as colunas: ' + faltando.join(', ') + '. Confira o cabeçalho da planilha.');
  const g = (r, k) => (C[k] >= 0 ? t(r[C[k]]) : '');

  // 1ª passada: monta os registros e marca as datas que não dá pra ler.
  const regs = []; const vistos = {};
  linhas.forEach((r, i) => {
    const pedido = g(r, 'pedido').replace(/\s+/g, ' ').split(' ').pop() || '';
    const sku = g(r, 'sku').toUpperCase();
    const lj = g(r, 'loja');
    if (!pedido && !sku && !lj && !g(r, 'cliente')) return; // linha vazia (só fórmula)
    const base = `${pedido || 'SEMPEDIDO-' + semAcento(g(r, 'cliente')).slice(0, 20)}|${sku}`;
    vistos[base] = (vistos[base] || 0) + 1;
    const L = loja(lj, pedido);
    const med = semAcento(g(r, 'mediacao'));
    const recl = g(r, 'reclamacao');
    regs.push({
      id: base + '|' + vistos[base], linha: i + 2, venda: pedido, dataLida: data(g(r, 'data')), dataOriginal: g(r, 'data'),
      dataCompra: data(g(r, 'dataCompra')), cliente: g(r, 'cliente'), loja: lj, plat: L.plat, conta: L.conta, canal: L.canal,
      frete: g(r, 'frete'), sku, un: num(g(r, 'qtd')) || 1, valor: Math.round(dinheiro(g(r, 'valor')) * 100) / 100,
      reclamacao: recl, motivoContato: g(r, 'motivoContato').replace(/^-$/, ''), estadoProduto: g(r, 'estadoProduto'),
      mediacao: g(r, 'mediacao'), status: g(r, 'status'), reputacao: g(r, 'reputacao'), destino: g(r, 'destino'),
      ganho: dinheiro(g(r, 'ganho')), ganhoML: dinheiro(g(r, 'ganhoML')), erroNosso: semAcento(g(r, 'erro')) === 'sim' ? 'SIM' : semAcento(g(r, 'erro')) === 'nao' ? 'NÃO' : '',
      conferencia: g(r, 'conferencia'), obs: g(r, 'obs'), categoria: categoria(g(r, 'categoria')),
      tipo: /cancelad/i.test(recl) ? 'Cancelamento' : med === 'sim' ? 'Mediação' : 'Devolução',
    });
  });
  // 2ª passada: data inválida recebe a data da linha mais próxima (de cima; se não tiver, de baixo).
  const avisos = [];
  regs.forEach((x, i) => {
    if (x.dataLida) { x.data = x.dataLida; x.dataAjustada = 0; return; }
    let d = '';
    for (let k = 1; !d && (i - k >= 0 || i + k < regs.length); k++) d = (regs[i - k] && regs[i - k].dataLida) || (regs[i + k] && regs[i + k].dataLida) || '';
    x.data = d || x.dataCompra || new Date().toISOString().slice(0, 10);
    x.dataAjustada = 1;
    avisos.push({ linha: x.linha, cliente: x.cliente, pedido: x.venda, dataOriginal: x.dataOriginal, usada: x.data });
  });
  regs.forEach((x) => { delete x.dataLida; if (!x.dataAjustada) delete x.dataOriginal; });
  cache = { em: Date.now(), regs, avisos };
  return cache;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });
  try {
    const { regs, avisos } = await baixarELer();
    const partes = Math.max(1, Math.ceil(regs.length / POR_PARTE));
    const parte = Math.min(Math.max(0, parseInt(req.query.parte, 10) || 0), partes - 1);
    return res.status(200).json({
      total: regs.length, partes, parte,
      regs: regs.slice(parte * POR_PARTE, (parte + 1) * POR_PARTE),
      avisos: parte === 0 ? avisos : [],
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Falha ao ler a planilha.' });
  }
}
