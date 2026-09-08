// Função serverless de login — verifica usuário/senha AQUI DENTRO (no servidor), sem nunca
// enviar as senhas guardadas pro navegador. Faz a migração sozinha: se a senha salva ainda
// estiver em texto puro (de antes dessa atualização), na primeira vez que a pessoa logar
// certo, o sistema já salva a versão criptografada (hash) no lugar — ninguém precisa trocar
// de senha, ninguém fica trancado pra fora.

import crypto from 'crypto';

function hashComSalt(senha, salt) {
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}
function novoHash(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + hashComSalt(senha, salt);
}
// Confere a senha digitada contra o valor salvo. Aceita tanto o formato novo ("salt:hash")
// quanto senha antiga em texto puro (pra não travar ninguém que ainda não migrou).
function senhaConfere(digitada, salva) {
  if (!salva) return false;
  if (salva.includes(':') && salva.length > 40) {
    const [salt, hash] = salva.split(':');
    try { return hashComSalt(digitada, salt) === hash; } catch { return false; }
  }
  return digitada === salva;
}
function precisaMigrar(salva) {
  return !(salva && salva.includes(':') && salva.length > 40);
}

async function getKV(base, key, headers) {
  const r = await fetch(`${base}/rest/v1/crm_kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows.length ? rows[0].value : null;
}
async function setKV(base, key, value, headers) {
  await fetch(`${base}/rest/v1/crm_kv?on_conflict=key`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ error: 'Informe usuário e senha.' });

  try {
    const config = (await getKV(SUPABASE_URL, 'crm:config', headers)) || {};
    const vendors = (await getKV(SUPABASE_URL, 'crm:vendors', headers)) || [];
    const diretores = (await getKV(SUPABASE_URL, 'crm:diretores', headers)) || [];

    // Gerente
    const usuarioGerente = config.usuarioGerente || 'michael';
    if (usuario === usuarioGerente) {
      if (senhaConfere(senha, config.senhaGerente)) {
        if (precisaMigrar(config.senhaGerente)) {
          config.senhaGerente = novoHash(senha);
          await setKV(SUPABASE_URL, 'crm:config', config, headers);
        }
        return res.status(200).json({ ok: true, tipo: 'gerente', nome: config.nomeGerente || 'Michael', foto: config.fotoGerente || null });
      }
      return res.status(200).json({ ok: false, message: 'Senha incorreta.' });
    }

    // Diretores
    const diretor = diretores.find(d => d.usuario === usuario);
    if (diretor) {
      if (senhaConfere(senha, diretor.senha)) {
        if (precisaMigrar(diretor.senha)) {
          diretor.senha = novoHash(senha);
          await setKV(SUPABASE_URL, 'crm:diretores', diretores, headers);
        }
        return res.status(200).json({ ok: true, tipo: 'gerente', nome: diretor.nome, foto: diretor.foto || null });
      }
      return res.status(200).json({ ok: false, message: 'Senha incorreta.' });
    }

    // Financeiro
    const usuarioFinanceiro = config.usuarioFinanceiro || 'financeiro';
    if (usuario === usuarioFinanceiro) {
      if (senhaConfere(senha, config.senhaFinanceiro)) {
        if (precisaMigrar(config.senhaFinanceiro)) {
          config.senhaFinanceiro = novoHash(senha);
          await setKV(SUPABASE_URL, 'crm:config', config, headers);
        }
        return res.status(200).json({ ok: true, tipo: 'financeiro', nome: config.nomeFinanceiro || 'Financeiro', foto: config.fotoFinanceiro || null });
      }
      return res.status(200).json({ ok: false, message: 'Senha incorreta.' });
    }

    // Compras (só cuida da Previsão de Compras)
    const usuarioCompras = config.usuarioCompras || 'roberto';
    if (usuario === usuarioCompras) {
      if (senhaConfere(senha, config.senhaCompras)) {
        if (precisaMigrar(config.senhaCompras)) {
          config.senhaCompras = novoHash(senha);
          await setKV(SUPABASE_URL, 'crm:config', config, headers);
        }
        return res.status(200).json({ ok: true, tipo: 'compras', nome: config.nomeCompras || 'Compras', foto: config.fotoCompras || null });
      }
      return res.status(200).json({ ok: false, message: 'Senha incorreta.' });
    }

    // Vendedor
    const vendedor = vendors.find(v => v.usuario === usuario);
    if (vendedor) {
      if (senhaConfere(senha, vendedor.senha)) {
        if (precisaMigrar(vendedor.senha)) {
          vendedor.senha = novoHash(senha);
          await setKV(SUPABASE_URL, 'crm:vendors', vendors, headers);
        }
        return res.status(200).json({ ok: true, tipo: 'vendedor', nome: vendedor.nome, codigo: vendedor.codigo });
      }
      return res.status(200).json({ ok: false, message: 'Senha incorreta.' });
    }

    return res.status(200).json({ ok: false, message: 'Usuário não encontrado.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no servidor: ' + err.message });
  }
}
