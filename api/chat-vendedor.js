// Assistente de IA pro vendedor — usa a MESMA chave gratuita do Gemini que já usamos
// pra ler PDF de pedido. Recebe a pergunta + um resumo dos dados daquele vendedor
// (carteira, estoque, vendas) e devolve uma resposta em português.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Chave do Gemini não configurada no servidor.' });

  const { pergunta, contexto } = req.body || {};
  if (!pergunta || !contexto) return res.status(400).json({ error: 'Pergunta ou contexto ausente.' });

  const prompt = `Você é um assistente de vendas de uma distribuidora de peças eletrônicas (TF Imports). Responda SEMPRE em português do Brasil, de forma direta e prática, como se estivesse falando com o vendedor pelo WhatsApp — sem enrolação, sem repetir a pergunta dele.

Use SOMENTE os dados abaixo pra responder. Se a informação pedida não estiver nos dados NEM puder ser calculada a partir deles, diga claramente que não tem esse dado, não invente números.

IMPORTANTE: você pode e deve fazer contas simples com os dados fornecidos quando fizer sentido — por exemplo, se pedirem o "valor unitário" de um item e você só tem "valor total" e "quantidade", calcule você mesmo (valor total ÷ quantidade) em vez de dizer que não tem o dado. O mesmo vale pra médias, somas, percentuais etc — sempre que der pra derivar da informação disponível, calcule.

MUITO IMPORTANTE sobre preços dos itens comprados: cada item tem dois valores possíveis — "valor" (uso interno/financeiro da empresa) e "precoListaTotal"/"precoUnitarioMedio" (o preço REAL do produto, sem imposto, que é o que interessa pro vendedor saber quanto o cliente pagou por unidade). Sempre que o vendedor perguntar "preço", "valor unitário", "quanto custou" ou algo parecido sobre um item comprado por um cliente, use o "precoUnitarioMedio" (ou "precoListaTotal" dividido pela quantidade) — NUNCA o campo "valor". Só use "valor" se perguntarem especificamente por ele.

Se a resposta for uma LISTA ou TABELA de itens (ex: lista de SKUs, lista de clientes), depois da sua resposta em texto normal, inclua TAMBÉM um bloco assim, com os mesmos dados organizados em tabela, pra virar uma planilha:

\`\`\`tabela
[{"Coluna 1": "valor", "Coluna 2": "valor"}, {"Coluna 1": "valor2", "Coluna 2": "valor2"}]
\`\`\`

Use nomes de coluna claros em português. Se a resposta for só uma frase ou número, NÃO inclua esse bloco.

DADOS DISPONÍVEIS (JSON):
${JSON.stringify(contexto)}

PERGUNTA DO VENDEDOR:
${pergunta}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
  const corpo = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

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
          await new Promise(r => setTimeout(r, 1500 * tentativa));
          continue;
        }
        return res.status(response.status).json({ error: mensagem });
      }
      const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Não consegui gerar uma resposta.';
      return res.status(200).json({ resposta: texto });
    } catch (err) {
      ultimoErro = err.message;
      if (tentativa < MAX_TENTATIVAS) { await new Promise(r => setTimeout(r, 1500 * tentativa)); continue; }
      return res.status(500).json({ error: 'Falha ao consultar a IA: ' + ultimoErro });
    }
  }
  return res.status(500).json({ error: 'Falha ao consultar a IA: ' + ultimoErro });
}
