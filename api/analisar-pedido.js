// Função serverless do Vercel (roda no servidor, nunca no navegador do vendedor).
// Recebe o PDF em base64, chama a API GRATUITA do Google Gemini usando a chave
// guardada nas variáveis de ambiente do projeto (GEMINI_API_KEY), e devolve o
// resultado já no mesmo formato que o CRM espera — a chave nunca é exposta pro navegador.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY não configurada no Vercel. Vá em Settings → Environment Variables e adicione.',
    });
  }

  const { base64, prompt } = req.body || {};
  if (!base64 || !prompt) {
    return res.status(400).json({ error: 'PDF ou instrução ausente na requisição.' });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: 'application/pdf', data: base64 } },
              { text: prompt },
            ],
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'Erro ao consultar o Gemini.' });
    }
    // Repacota no mesmo formato {content:[{type:'text', text:...}]} que o front-end já sabe ler,
    // pra não precisar mexer em mais nada do lado do CRM.
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({ content: [{ type: 'text', text: texto }] });
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao processar o pedido: ' + err.message });
  }
}
