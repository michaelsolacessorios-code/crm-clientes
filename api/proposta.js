// Função serverless das PROPOSTAS / DESAFIOS de cliente — mesmo padrão do garantia.js.
//
// Cada proposta fica numa linha própria da tabela crm_kv (chave "crm:proposta:000001"), então
// ninguém sobrescreve a proposta de outro. O número vem de crm_proximo_numero('proposta').
// O arquivo enviado ao cliente (.pptx/.pdf) fica no espaço de arquivos privado "propostas" (Storage).
//
// GET  /api/proposta?acao=listar                         -> { propostas: [...] }
// POST /api/proposta { acao:'proximo-numero' }            -> { numero }
// POST /api/proposta { acao:'salvar', proposta }          -> { ok, proposta }  (409 se alguém mexeu antes)
// POST /api/proposta { acao:'registrar-pedido', numero, pedido } -> { ok, proposta }  (acrescenta, sem duplicar)
// POST /api/proposta { acao:'url-upload', nome }          -> { path, uploadUrl }
// POST /api/proposta { acao:'url-arquivo', path, nome }   -> { url }
// POST /api/proposta { acao:'analisar', texto }           -> { dados }  (IA lê o texto dos slides)

const BUCKET = 'propostas';
const PREFIXO = 'crm:proposta:';

function chave(numero) {
  return PREFIXO + String(numero).padStart(6, '0');
}

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Configuração do servidor incompleta (SUPABASE_URL / SUPABASE_SERVICE_KEY faltando).' });
  }
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  async function lerLinha(key) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers });
    if (!r.ok) throw new Error('Falha ao buscar do banco.');
    const rows = await r.json();
    return rows.length ? rows[0].value : null;
  }
  async function gravarLinha(key, value) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv?on_conflict=key`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value, updated_at: value.atualizadoEm }),
    });
    if (!r.ok) throw new Error('Falha ao salvar a proposta.');
  }

  try {
    if (req.method === 'GET') {
      if (req.query.acao !== 'listar') return res.status(400).json({ error: 'Ação inválida.' });
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/crm_kv?key=like.${encodeURIComponent(PREFIXO + '*')}&select=value&order=key.asc`,
        { headers }
      );
      if (!r.ok) return res.status(502).json({ error: 'Falha ao buscar as propostas.' });
      const rows = await r.json();
      return res.status(200).json({ propostas: rows.map(x => x.value).filter(Boolean) });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
    const body = req.body || {};

    if (body.acao === 'proximo-numero') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_proximo_numero`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_nome: 'proposta' }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Não consegui gerar o número da proposta.' });
      return res.status(200).json({ numero: Number(await r.json()) });
    }

    if (body.acao === 'salvar') {
      const p = body.proposta;
      if (!p || !p.numero) return res.status(400).json({ error: 'Proposta sem número.' });
      const key = chave(p.numero);
      const atual = await lerLinha(key);
      const versaoAtual = atual ? (atual.versao || 0) : 0;
      if ((p.versao || 0) !== versaoAtual) {
        return res.status(409).json({ error: 'Essa proposta foi alterada por outra pessoa enquanto você estava com ela aberta. Feche e abra de novo.', atual });
      }
      // Os pedidos contados são gravados só por 'registrar-pedido': nunca perde pedido por cópia velha.
      const pedidos = mesclarPedidos(atual && atual.pedidos, p.pedidos);
      const nova = { ...p, pedidos, versao: versaoAtual + 1, atualizadoEm: new Date().toISOString() };
      await gravarLinha(key, nova);
      return res.status(200).json({ ok: true, proposta: nova });
    }

    if (body.acao === 'registrar-pedido') {
      const ped = body.pedido;
      if (!body.numero || !ped || !ped.id) return res.status(400).json({ error: 'Pedido inválido.' });
      const key = chave(body.numero);
      const atual = await lerLinha(key);
      if (!atual) return res.status(404).json({ error: 'Proposta não encontrada.' });
      if ((atual.pedidos || []).some(x => x.id === ped.id)) return res.status(200).json({ ok: true, proposta: atual, jaExistia: true });
      const nova = { ...atual, pedidos: [...(atual.pedidos || []), ped], versao: (atual.versao || 0) + 1, atualizadoEm: new Date().toISOString() };
      await gravarLinha(key, nova);
      return res.status(200).json({ ok: true, proposta: nova });
    }

    if (body.acao === 'url-upload') {
      const agora = new Date();
      const pasta = agora.getFullYear() + '-' + String(agora.getMonth() + 1).padStart(2, '0');
      const ext = (String(body.nome || '').match(/\.(pptx|ppt|pdf)$/i) || ['', 'pptx'])[1].toLowerCase();
      const aleatorio = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const path = `${pasta}/${aleatorio}.${ext}`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.url) return res.status(502).json({ error: 'Não consegui preparar o envio do arquivo.' });
      return res.status(200).json({ path, uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}` });
    }

    if (body.acao === 'url-arquivo') {
      const path = String(body.path || '');
      if (!path || path.includes('..')) return res.status(400).json({ error: 'Arquivo inválido.' });
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      const data = await r.json().catch(() => ({}));
      const assinado = data.signedURL || data.signedUrl;
      if (!r.ok || !assinado) return res.status(502).json({ error: 'Não consegui abrir o arquivo.' });
      const nome = String(body.nome || '').replace(/[^\w.\- ]+/g, '_');
      const sep = assinado.includes('?') ? '&' : '?';
      return res.status(200).json({ url: `${SUPABASE_URL}/storage/v1${assinado}${nome ? `${sep}download=${encodeURIComponent(nome)}` : ''}` });
    }

    if (body.acao === 'analisar') {
      return await analisarComIA(String(body.texto || ''), res);
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no servidor: ' + err.message });
  }
}

function mesclarPedidos(doBanco, doCliente) {
  const mapa = new Map();
  (doBanco || []).forEach(p => p && p.id && mapa.set(p.id, p));
  // Do cliente só aceita mudança de "ignorado" (gerente tirando um pedido do contador) em pedido que já existe.
  (doCliente || []).forEach(p => {
    if (!p || !p.id) return;
    const ex = mapa.get(p.id);
    if (ex) mapa.set(p.id, { ...ex, ignorado: !!p.ignorado, ignoradoPor: p.ignoradoPor || ex.ignoradoPor || null });
    else mapa.set(p.id, p);
  });
  return Array.from(mapa.values());
}

async function analisarComIA(texto, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no Vercel.' });
  if (texto.trim().length < 20) return res.status(400).json({ error: 'Não achei texto nos slides.' });
  const prompt = `Você recebe o texto extraído dos slides de uma proposta comercial (desafio de compras) que a TF Imports enviou a um cliente lojista.
Extraia os dados do desafio e responda APENAS com um JSON válido, sem texto antes ou depois, neste formato:
{"titulo":"","clientes":"","clienteCodigos":[],"duracaoDias":90,"metaValor":0,"metaSkus":0,"metaVolume":0,"faixas":[{"valorMes":0,"pct":0}],"regras":[""],"resumo":""}
- titulo: nome curto da proposta (ex: "Plano de Crescimento 4º tri 2026 — Grupo X").
- clientes: nome(s) do cliente/grupo como aparece no texto.
- clienteCodigos: números de cadastro de cliente se aparecerem no texto (como texto); senão [].
- duracaoDias: duração do desafio em dias (trimestre = 90).
- metaValor: meta de compras do PERÍODO TODO em reais, número puro (ex: R$ 300 mil no trimestre = 300000).
- metaSkus: meta de SKUs/mix ativos no período (número), 0 se não houver.
- metaVolume: meta de volume em unidades no período (número), 0 se a proposta não definir meta de volume.
- faixas: faixas de cashback por compra MENSAL (valorMes em reais, pct em %), em ordem crescente. Ex: R$ 50 mil/mês = 5%.
- regras: lista curta com as regras e combinados da proposta (frases curtas).
- resumo: 2 a 3 frases resumindo o desafio.
Use número puro (sem R$, sem ponto de milhar). Se algum dado não existir, use 0 ou lista vazia.

TEXTO DOS SLIDES:
${texto.slice(0, 60000)}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
  const corpo = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
  });
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo });
      const data = await r.json();
      if (!r.ok) {
        const msg = data?.error?.message || 'Erro ao consultar o Gemini.';
        if ((r.status === 503 || r.status === 429 || /overloaded|high demand|quota/i.test(msg)) && tentativa < 3) {
          ultimoErro = msg; await new Promise(ok => setTimeout(ok, 1500 * tentativa)); continue;
        }
        return res.status(r.status).json({ error: msg });
      }
      const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const limpo = txt.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      try { return res.status(200).json({ dados: JSON.parse(limpo) }); }
      catch (e) { return res.status(502).json({ error: 'A IA respondeu num formato inesperado. Preencha manualmente.' }); }
    } catch (err) {
      ultimoErro = err.message;
      if (tentativa < 3) { await new Promise(ok => setTimeout(ok, 1500 * tentativa)); continue; }
    }
  }
  return res.status(500).json({ error: 'Falha ao consultar a IA: ' + ultimoErro });
}
