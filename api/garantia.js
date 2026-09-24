// Função serverless das GARANTIAS — fala com o Supabase guardando a chave em segredo (igual ao kv.js).
//
// Cada garantia fica numa linha própria da tabela crm_kv (chave "crm:garantia:000123"), então
// dois vendedores lançando ao mesmo tempo nunca sobrescrevem a garantia um do outro.
// O número vem de uma função do banco (crm_proximo_numero) que nunca repete número.
// Os PDFs ficam no espaço de arquivos privado "garantias" do Supabase (Storage), fora da tabela.
//
// GET  /api/garantia?acao=listar                      -> { garantias: [...] }
// POST /api/garantia { acao:'proximo-numero' }         -> { numero }
// POST /api/garantia { acao:'salvar', garantia }       -> { ok, garantia }  (409 se alguém mexeu antes)
// POST /api/garantia { acao:'url-upload', nome }       -> { path, uploadUrl }
// POST /api/garantia { acao:'url-pdf', path }          -> { url }

const BUCKET = 'garantias';
const PREFIXO = 'crm:garantia:';

function chaveDaGarantia(numero) {
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

  try {
    if (req.method === 'GET') {
      if (req.query.acao !== 'listar') return res.status(400).json({ error: 'Ação inválida.' });
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/crm_kv?key=like.${encodeURIComponent(PREFIXO + '*')}&select=value&order=key.asc`,
        { headers }
      );
      if (!r.ok) return res.status(502).json({ error: 'Falha ao buscar as garantias.' });
      const rows = await r.json();
      return res.status(200).json({ garantias: rows.map(x => x.value).filter(Boolean) });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
    const body = req.body || {};

    if (body.acao === 'proximo-numero') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_proximo_numero`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_nome: 'garantia' }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Não consegui gerar o número da garantia.' });
      const numero = await r.json();
      return res.status(200).json({ numero: Number(numero) });
    }

    if (body.acao === 'salvar') {
      const g = body.garantia;
      if (!g || !g.numero) return res.status(400).json({ error: 'Garantia sem número.' });
      const key = chaveDaGarantia(g.numero);
      // Proteção contra cópia velha: só grava se ninguém salvou essa garantia depois que ela foi aberta.
      const atual = await lerLinha(key);
      const versaoAtual = atual ? (atual.versao || 0) : 0;
      if ((g.versao || 0) !== versaoAtual) {
        return res.status(409).json({ error: 'Essa garantia foi alterada por outra pessoa enquanto você estava com ela aberta. Feche e abra de novo para ver a versão atual.', atual });
      }
      const nova = { ...g, versao: versaoAtual + 1, atualizadoEm: new Date().toISOString() };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv?on_conflict=key`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key, value: nova, updated_at: nova.atualizadoEm }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Falha ao salvar a garantia.' });
      return res.status(200).json({ ok: true, garantia: nova });
    }

    if (body.acao === 'url-upload') {
      const agora = new Date();
      const pasta = agora.getFullYear() + '-' + String(agora.getMonth() + 1).padStart(2, '0');
      const aleatorio = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const path = `${pasta}/${aleatorio}.pdf`;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.url) return res.status(502).json({ error: 'Não consegui preparar o envio do PDF.' });
      return res.status(200).json({ path, uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}` });
    }

    if (body.acao === 'url-pdf') {
      const path = String(body.path || '');
      if (!path || path.includes('..')) return res.status(400).json({ error: 'Arquivo inválido.' });
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      const data = await r.json().catch(() => ({}));
      const assinado = data.signedURL || data.signedUrl;
      if (!r.ok || !assinado) return res.status(502).json({ error: 'Não consegui abrir o PDF.' });
      return res.status(200).json({ url: `${SUPABASE_URL}/storage/v1${assinado}` });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no servidor: ' + err.message });
  }
}
