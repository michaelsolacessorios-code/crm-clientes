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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
  const corpo = JSON.stringify({
    contents: [
      {
        parts: [
          { inline_data: { mime_type: 'application/pdf', data: base64 } },
          { text: prompt },
        ],
      },
    ],
  });

  // O Google às vezes fica momentaneamente sobrecarregado ("high demand") — antes de desistir
  // e mandar a pessoa preencher na mão, tenta mais 2 vezes com uma pausa curta entre elas.
  const MAX_TENTATIVAS = 3;
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo });
      const data = await response.json();
      if (!response.ok) {
        const mensagem = data?.error?.message || 'Erro ao consultar o Gemini.';
        const sobrecarregado = response.status === 503 || response.status === 429 || /overloaded|high demand|quota/i.test(mensagem);
        if (sobrecarregado && tentativa < MAX_TENTATIVAS) {
          ultimoErro = mensagem;
          await new Promise(r => setTimeout(r, 1500 * tentativa)); // espera um pouco mais a cada tentativa
          continue;
        }
        return res.status(response.status).json({ error: mensagem });
      }
      const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ content: [{ type: 'text', text: texto }] });
    } catch (err) {
      ultimoErro = err.message;
      if (tentativa < MAX_TENTATIVAS) {
        await new Promise(r => setTimeout(r, 1500 * tentativa));
        continue;
      }
      return res.status(500).json({ error: 'Falha ao processar o pedido: ' + ultimoErro });
    }
  }
  return res.status(500).json({ error: 'Falha ao processar o pedido: ' + ultimoErro });
}
