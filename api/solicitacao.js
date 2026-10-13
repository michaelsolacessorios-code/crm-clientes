// Função serverless das SOLICITAÇÕES DE COMPRA de itens novos (aba Compras → Solicitação de Compra).
// Mesmo modelo da Reclamação: cada solicitação é uma linha própria da tabela crm_kv
// (chave "crm:solicitacao:000123"), número que nunca repete (crm_proximo_numero) e
// fotos (pedido, print do aceite, comprovantes) no espaço privado "solicitacoes" do Supabase (Storage).
// Nada é apagado: as etapas só avançam e cada mudança fica no histórico da solicitação.
//
// GET  /api/solicitacao?acao=listar                     -> { solicitacoes: [...] }
// POST /api/solicitacao { acao:'proximo-numero' }        -> { numero }
// POST /api/solicitacao { acao:'salvar', solicitacao }    -> { ok, solicitacao }  (409 se alguém mexeu antes)
// POST /api/solicitacao { acao:'url-upload' }            -> { path, uploadUrl }
// POST /api/solicitacao { acao:'urls-fotos', paths:[] }  -> { urls: { path: url } }

const BUCKET = 'solicitacoes';
const PREFIXO = 'crm:solicitacao:';

function chaveDaSolicitacao(numero) {
  return PREFIXO + String(numero).padStart(6, '0');
}
function pathValido(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('..') && /^[0-9]{4}-[0-9]{2}\/[a-z0-9]+\.jpg$/.test(p);
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

  try {
    if (req.method === 'GET') {
      if (req.query.acao !== 'listar') return res.status(400).json({ error: 'Ação inválida.' });
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/crm_kv?key=like.${encodeURIComponent(PREFIXO + '*')}&select=value&order=key.desc`,
        { headers }
      );
      if (!r.ok) return res.status(502).json({ error: 'Falha ao buscar as solicitações.' });
      const rows = await r.json();
      return res.status(200).json({ solicitacoes: rows.map(x => x.value).filter(Boolean) });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
    const body = req.body || {};

    if (body.acao === 'proximo-numero') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_proximo_numero`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_nome: 'solicitacao_compra' }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Não consegui gerar o número da solicitação.' });
      const numero = await r.json();
      return res.status(200).json({ numero: Number(numero) });
    }

    if (body.acao === 'salvar') {
      const rec = body.solicitacao;
      if (!rec || !rec.numero) return res.status(400).json({ error: 'Solicitação sem número.' });
      const key = chaveDaSolicitacao(rec.numero);
      // Proteção contra cópia velha: só grava se ninguém salvou essa solicitação depois que ela foi aberta.
      const atual = await lerLinha(key);
      const versaoAtual = atual ? (atual.versao || 0) : 0;
      if ((rec.versao || 0) !== versaoAtual) {
        return res.status(409).json({ error: 'Essa solicitação foi alterada por outra pessoa enquanto você estava com ela aberta. Feche e abra de novo para ver a versão atual.', atual });
      }
      const nova = { ...rec, versao: versaoAtual + 1, atualizadoEm: new Date().toISOString() };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv?on_conflict=key`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key, value: nova, updated_at: nova.atualizadoEm }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Falha ao salvar a solicitação.' });
      return res.status(200).json({ ok: true, solicitacao: nova });
    }

    if (body.acao === 'url-upload') {
      const agora = new Date();
      const pasta = agora.getFullYear() + '-' + String(agora.getMonth() + 1).padStart(2, '0');
      const aleatorio = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const path = `${pasta}/${aleatorio}.jpg`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.url) return res.status(502).json({ error: 'Não consegui preparar o envio da foto.' });
      return res.status(200).json({ path, uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}` });
    }

    if (body.acao === 'urls-fotos') {
      const paths = Array.isArray(body.paths) ? body.paths.filter(pathValido).slice(0, 100) : [];
      if (!paths.length) return res.status(200).json({ urls: {} });
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600, paths }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(data)) return res.status(502).json({ error: 'Não consegui abrir as fotos.' });
      const urls = {};
      data.forEach(item => {
        const assinado = item && (item.signedURL || item.signedUrl);
        if (item && item.path && assinado) urls[item.path] = `${SUPABASE_URL}/storage/v1${assinado}`;
      });
      return res.status(200).json({ urls });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no servidor: ' + err.message });
  }
}
