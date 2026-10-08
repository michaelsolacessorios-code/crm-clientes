// Função serverless do CONTROLE DE SAÍDA (Estoque › Saída e Estoque › Informar NF).
// Fala com o Supabase guardando a chave em segredo (igual ao kv.js / garantia.js).
//
// Cada registro é uma linha própria da tabela crm_kv, então duas pessoas lançando ao mesmo
// tempo nunca sobrescrevem o trabalho uma da outra:
//   "crm:nf:<nf>:<vend>-<id>"  -> NF informada no pedido pelo faturamento (liga NF ↔ pedido).
//                                 Uma NF pode faturar mais de um pedido do mesmo cliente.
//   "crm:saida:<nf>:<carimbo>" -> uma NF que saiu numa coleta (transportadora, motorista, placa, volumes)
// Nada é apagado: NF trocada vira "substituida", saída desfeita vira "cancelada" (com motivo e histórico).
//
// GET  /api/saida?acao=listar                                   -> { nfs:[...], saidas:[...] }
// POST /api/saida { acao:'vincular-nf', nf, pedido, por }        -> { ok, link }   (409 se a NF já é de outro pedido)
// POST /api/saida { acao:'registrar', coleta, itens, por }       -> { ok, saidas } (409 se alguma NF já saiu)
// POST /api/saida { acao:'cancelar', key, motivo, por }          -> { ok, saida }

const PREFIXO_NF = 'crm:nf:';
const PREFIXO_SAIDA = 'crm:saida:';

function chaveLink(nf, chavePedido) { return `${PREFIXO_NF}${nf}:${String(chavePedido).replace('|', '-')}`; }
function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+(?=\d)/, ''); }

// Data e hora de Brasília, do servidor (ninguém consegue lançar com data errada).
function agoraSP() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(partes.map(x => [x.type, x.value]));
  const hora = (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
  return { data: `${p.year}-${p.month}-${p.day}`, hora };
}

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Configuração do servidor incompleta (SUPABASE_URL / SUPABASE_SERVICE_KEY faltando).' });
  }
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  async function listarPrefixo(prefixo, filtroExtra) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/crm_kv?key=like.${encodeURIComponent(prefixo + '*')}${filtroExtra || ''}&select=key,value&order=key.asc`,
      { headers }
    );
    if (!r.ok) throw new Error('Falha ao buscar do banco.');
    return (await r.json()).filter(x => x.value);
  }
  async function lerLinha(key) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv?key=eq.${encodeURIComponent(key)}&select=value`, { headers });
    if (!r.ok) throw new Error('Falha ao buscar do banco.');
    const rows = await r.json();
    return rows.length ? rows[0].value : null;
  }
  async function gravar(linhas, sobrescrever) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/crm_kv${sobrescrever ? '?on_conflict=key' : ''}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json',
        Prefer: (sobrescrever ? 'resolution=merge-duplicates,' : '') + 'return=minimal' },
      body: JSON.stringify(linhas.map(l => ({ key: l.key, value: l.value, updated_at: new Date().toISOString() }))),
    });
    if (!r.ok) throw new Error('Falha ao salvar no banco.');
  }
  async function linksAtivosDaNf(nf) {
    return (await listarPrefixo(PREFIXO_NF + nf + ':', '&value->>status=eq.ativa')).map(x => x.value);
  }
  async function saidaAtivaDaNf(nf) {
    const rows = await listarPrefixo(PREFIXO_SAIDA + nf + ':', '&value->>status=eq.ativa');
    return rows.length ? rows[0].value : null;
  }

  try {
    if (req.method === 'GET') {
      if (req.query.acao !== 'listar') return res.status(400).json({ error: 'Ação inválida.' });
      const [nfs, saidas] = await Promise.all([listarPrefixo(PREFIXO_NF), listarPrefixo(PREFIXO_SAIDA)]);
      return res.status(200).json({
        nfs: nfs.map(x => ({ ...x.value, key: x.key })),
        saidas: saidas.map(x => ({ ...x.value, key: x.key })),
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });
    const body = req.body || {};
    const por = String(body.por || '').slice(0, 80) || 'Sem nome';
    const agoraIso = new Date().toISOString();

    // ---------- Faturamento informa a NF no pedido ----------
    if (body.acao === 'vincular-nf') {
      const nf = soDigitos(body.nf);
      const p = body.pedido || {};
      if (!nf) return res.status(400).json({ error: 'Informe o número da NF.' });
      if (!p.pedidoId || !p.vendedorCodigo) return res.status(400).json({ error: 'Pedido inválido.' });
      const chavePedido = `${p.vendedorCodigo}|${p.pedidoId}`;

      const daNf = await linksAtivosDaNf(nf);
      if (daNf.some(l => l.chavePedido === chavePedido)) {
        return res.status(200).json({ ok: true, link: daNf.find(l => l.chavePedido === chavePedido) });
      }
      const outroCliente = daNf.find(l => String(l.clienteCodigo) !== String(p.clienteCodigo || ''));
      if (outroCliente) {
        return res.status(409).json({ error: `A NF ${nf} já está no pedido ${outroCliente.numeroPedido || ''} de outro cliente (${outroCliente.clienteNome || ''}). Confira o número.` });
      }
      if (await saidaAtivaDaNf(nf)) {
        return res.status(409).json({ error: `A NF ${nf} já saiu. Não dá para incluir mais pedidos nela.` });
      }

      // Se esse pedido já tinha outra NF: só deixa trocar se ela ainda não saiu; a antiga vira "substituida".
      const antigas = (await listarPrefixo(PREFIXO_NF, `&value->>chavePedido=eq.${encodeURIComponent(chavePedido)}&value->>status=eq.ativa`)).map(x => x.value);
      for (const a of antigas) {
        if (await saidaAtivaDaNf(a.nf)) {
          return res.status(409).json({ error: `Esse pedido já saiu com a NF ${a.nf}. Para trocar, o estoque precisa cancelar a saída primeiro.` });
        }
      }
      const linhas = antigas.map(a => ({
        key: chaveLink(a.nf, chavePedido),
        value: { ...a, status: 'substituida', historico: [...(a.historico || []), { em: agoraIso, por, acao: `substituída pela NF ${nf}` }] },
      }));
      const link = {
        nf, status: 'ativa', chavePedido,
        vendedorCodigo: Number(p.vendedorCodigo), pedidoId: String(p.pedidoId),
        numeroPedido: String(p.numeroPedido || ''), clienteCodigo: String(p.clienteCodigo || ''),
        clienteNome: String(p.clienteNome || ''), valor: Number(p.valor) || 0, dataPedido: String(p.data || ''),
        informadoPor: por, informadoEm: agoraIso,
        historico: [{ em: agoraIso, por, acao: 'NF informada no pedido' }],
      };
      linhas.push({ key: chaveLink(nf, chavePedido), value: link });
      await gravar(linhas, true);
      return res.status(200).json({ ok: true, link });
    }

    // ---------- Estoque registra a saída de uma coleta ----------
    if (body.acao === 'registrar') {
      const c = body.coleta || {};
      const transportadora = String(c.transportadora || '').trim().toUpperCase();
      const motorista = String(c.motorista || '').trim();
      const placa = String(c.placa || '').trim().toUpperCase();
      const documento = String(c.documento || '').trim();
      // Transportadora e entrega própria exigem placa; cliente que retira (RETIRA) só precisa do nome de quem buscou.
      if (!transportadora || !motorista) return res.status(400).json({ error: 'Informe transportadora e motorista (ou quem retirou).' });
      if (!placa && transportadora !== 'RETIRA') return res.status(400).json({ error: 'Informe a placa do veículo.' });
      const itens = Array.isArray(body.itens) ? body.itens : [];
      if (!itens.length) return res.status(400).json({ error: 'Nenhuma NF informada.' });

      const vistos = new Set();
      const erros = [];
      const prontos = [];
      for (const it of itens) {
        const nf = soDigitos(it.nf);
        const volumes = Math.round(Number(it.volumes) || 0);
        if (!nf) { erros.push('Linha sem número de NF.'); continue; }
        if (vistos.has(nf)) { erros.push(`NF ${nf} repetida nesta coleta.`); continue; }
        vistos.add(nf);
        if (volumes <= 0) { erros.push(`NF ${nf}: informe os volumes.`); continue; }
        const ja = await saidaAtivaDaNf(nf);
        if (ja) { erros.push(`A NF ${nf} já saiu em ${ja.data.split('-').reverse().join('/')} às ${ja.hora} (${ja.transportadora}).`); continue; }
        const links = await linksAtivosDaNf(nf);
        const ativo = links.length ? links : null;
        if (!ativo && !it.avulsa) { erros.push(`NF ${nf} não está ligada a nenhum pedido.`); continue; }
        if (!ativo && !String(it.clienteNome || '').trim()) { erros.push(`NF ${nf}: informe o cliente.`); continue; }
        prontos.push({ nf, volumes, ativo, it });
      }
      if (erros.length) return res.status(409).json({ error: erros.join('\n') });

      const { data, hora } = agoraSP();
      const coletaId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const carimbo = Date.now();
      const linhas = prontos.map(({ nf, volumes, ativo, it }) => {
        const value = {
          nf, volumes, status: 'ativa', coletaId, data, hora,
          transportadora, motorista, placa, documento,
          avulsa: !ativo,
          pedidos: ativo ? ativo.map(l => ({ chavePedido: l.chavePedido, vendedorCodigo: l.vendedorCodigo, pedidoId: l.pedidoId, numeroPedido: l.numeroPedido, valor: Number(l.valor) || 0 })) : [],
          chavePedido: ativo ? ativo[0].chavePedido : null,
          vendedorCodigo: ativo ? ativo[0].vendedorCodigo : null,
          pedidoId: ativo ? ativo[0].pedidoId : null,
          numeroPedido: ativo ? [...new Set(ativo.map(l => l.numeroPedido))].join(', ') : '',
          clienteCodigo: ativo ? ativo[0].clienteCodigo : '',
          clienteNome: ativo ? ativo[0].clienteNome : String(it.clienteNome).trim(),
          valor: ativo ? Math.round(ativo.reduce((t, l) => t + (Number(l.valor) || 0), 0) * 100) / 100 : (Number(it.valor) || 0),
          registradoPor: por, registradoEm: agoraIso,
          historico: [{ em: agoraIso, por, acao: 'saída registrada' }],
        };
        return { key: `${PREFIXO_SAIDA}${nf}:${carimbo}`, value };
      });
      await gravar(linhas, false);
      return res.status(200).json({ ok: true, saidas: linhas.map(l => ({ ...l.value, key: l.key })) });
    }

    // ---------- Desfazer uma saída (fica registrada como cancelada) ----------
    if (body.acao === 'cancelar') {
      const key = String(body.key || '');
      const motivo = String(body.motivo || '').trim();
      if (!key.startsWith(PREFIXO_SAIDA)) return res.status(400).json({ error: 'Saída inválida.' });
      if (!motivo) return res.status(400).json({ error: 'Informe o motivo.' });
      const s = await lerLinha(key);
      if (!s) return res.status(404).json({ error: 'Saída não encontrada.' });
      if (s.status !== 'ativa') return res.status(409).json({ error: 'Essa saída já estava cancelada.' });
      const nova = { ...s, status: 'cancelada', canceladoPor: por, canceladoEm: agoraIso, motivoCancelamento: motivo,
        historico: [...(s.historico || []), { em: agoraIso, por, acao: 'cancelada', motivo }] };
      await gravar([{ key, value: nova }], true);
      return res.status(200).json({ ok: true, saida: { ...nova, key } });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erro no servidor: ' + err.message });
  }
}
