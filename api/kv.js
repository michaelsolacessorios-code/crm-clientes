// Função serverless do Vercel — a ÚNICA coisa que fala direto com o Supabase agora.
// A chave do banco fica guardada em segredo aqui (variável de ambiente), nunca mais
// exposta no código que roda no navegador do vendedor.
//
// GET  /api/kv?key=crm:roster        -> { value: ... }
// POST /api/kv  { key, value }       -> { ok: true }

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Configuração do servidor incompleta (SUPABASE_URL / SUPABASE_SERVICE_KEY faltando).' });
  }

  try {
    if (req.method === 'GET') {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: 'Parâmetro "key" é obrigatório.' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv?key=eq.${encodeURIComponent(key)}&select=value`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!r.ok) return res.status(502).json({ error: 'Falha ao buscar do banco.' });
      const rows = await r.json();
      return res.status(200).json({ value: rows.length ? rows[0].value : null });
    }

    if (req.method === 'POST') {
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ error: 'Campo "key" é obrigatório.' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv?on_conflict=key`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Falha ao salvar no banco.' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Método não permitido.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no servidor: ' + err.message });
  }
}
