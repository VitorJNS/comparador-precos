// Envio de alertas por e-mail (SMTP; pensado para Gmail com "senha de app").

import nodemailer from 'nodemailer';
import { q, listProducts, listUsers, watchersByProduct } from './db.js';
import { dedupeEvents, rankOffers, getOffers, nameOfMarket } from './queries.js';

const brl = (n) => (n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function emailConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function transport() {
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const EVENT_LABEL = {
  minimo: { icon: '★', label: 'Menor preço já registrado', color: '#006300' },
  queda: { icon: '▼', label: 'Preço caiu', color: '#006300' },
  promocao: { icon: '%', label: 'Entrou em promoção', color: '#1c5cab' },
  voltou: { icon: '↺', label: 'Voltou ao estoque', color: '#1c5cab' },
  aumento: { icon: '▲', label: 'Preço subiu', color: '#b42318' },
};

function eventLine(e) {
  const meta = EVENT_LABEL[e.type];
  // Promoção compara com o preço "de" do site; os demais, com o preço da coleta anterior.
  const ref = e.type === 'promocao' ? e.list_price : e.old_price;
  const pct = ref && e.new_price && ref !== e.new_price ? Math.round((e.new_price / ref - 1) * 1000) / 10 : null;
  const change =
    ref && ref !== e.new_price
      ? `<span style="color:#898781;text-decoration:line-through">${brl(ref)}</span> → `
      : '';
  return `<tr>
    <td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:top;width:28px;color:${meta.color};font-weight:700;font-size:16px">${meta.icon}</td>
    <td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:top">
      <div style="font-weight:600;color:#0b0b0b">${meta.label}${pct ? ` <span style="color:${meta.color}">(${pct > 0 ? '+' : ''}${pct.toString().replace('.', ',')}%)</span>` : ''}</div>
      <div style="color:#52514e;font-size:13px">${esc(e.store_name)} · ${esc(nameOfMarket(e.market))}</div>
    </td>
    <td style="padding:10px 0;border-bottom:1px solid #eee;vertical-align:top;text-align:right;white-space:nowrap">
      ${change}<strong style="font-size:16px;color:#0b0b0b">${brl(e.new_price)}</strong>
      ${e.url ? `<div><a href="${esc(e.url)}" style="color:#1c5cab;font-size:13px">ver oferta</a></div>` : ''}
    </td>
  </tr>`;
}

function rankingBlock(offers) {
  const top = rankOffers(offers).filter((g) => g.available).slice(0, 3);
  if (!top.length) return '<p style="color:#898781;font-size:13px">Nenhuma oferta disponível no momento.</p>';
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">${top
    .map(
      (g, i) => `<tr>
        <td style="padding:6px 0;color:#898781;width:24px">${i + 1}º</td>
        <td style="padding:6px 0;color:#0b0b0b">${esc(g.marketName)} <span style="color:#898781">· ${g.stores.length > 1 ? `${g.stores.length} lojas` : esc(g.stores[0].name)}</span></td>
        <td style="padding:6px 0;text-align:right;font-weight:600;color:#0b0b0b">${brl(g.price)}${g.promo ? ` <span style="color:#1c5cab;font-weight:400">(-${g.discountPct}%)</span>` : ''}</td>
        <td style="padding:6px 0 6px 12px;text-align:right;width:1%;white-space:nowrap">${i === 0 && g.url ? `<a href="${esc(g.url)}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;font-size:12px;font-weight:600;padding:4px 10px;border-radius:6px">Abrir no ${esc(g.marketName)}</a>` : ''}</td>
      </tr>`,
    )
    .join('')}</table>`;
}

// Carrega as ofertas de cada produto (na região da pessoa); resumos só listam os que têm alguma disponível.
async function withOffers(products, keepEmpty = false, region = 'todas') {
  const out = [];
  for (const p of products) {
    const offers = await getOffers(p.id, region);
    if (offers.length || keepEmpty) out.push({ product: p, offers });
  }
  return out;
}

// Endereço do painel: na Vercel, o domínio de produção; localmente, localhost.
export const panelUrl = () =>
  process.env.PAINEL_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT || 3000}`);

function buildHtml(sections, title) {
  const panel = panelUrl();
  return `<!doctype html><html><body style="margin:0;background:#f4f4f1;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:620px;margin:0 auto;padding:24px 16px">
    <div style="font-size:13px;color:#52514e;letter-spacing:.04em;text-transform:uppercase;font-weight:600">Radar de Preços</div>
    <h1 style="margin:4px 0 20px;font-size:22px;color:#0b0b0b">${esc(title)}</h1>
    ${sections
      .map(
        (s) => `<div style="background:#fff;border-radius:12px;padding:18px 20px;margin-bottom:16px;border:1px solid #e1e0d9">
        <h2 style="margin:0 0 6px;font-size:17px;color:#0b0b0b">${esc(s.product.name)}</h2>
        ${s.events.length ? `<table style="width:100%;border-collapse:collapse">${s.events.map(eventLine).join('')}</table>` : ''}
        <div style="margin-top:14px;font-size:12px;color:#898781;text-transform:uppercase;letter-spacing:.04em;font-weight:600">Ranking atual</div>
        ${rankingBlock(s.offers)}
      </div>`,
      )
      .join('')}
    <p style="font-size:12px;color:#898781">Abra o painel em <a href="${panel}" style="color:#1c5cab">${panel}</a> </p>
  </div></body></html>`;
}

// Cada pessoa recebe o próprio e-mail (ninguém vê o endereço nem os produtos dos outros).
async function send(to, subject, html) {
  await transport().sendMail({ from: `"Radar de Preços" <${process.env.SMTP_USER}>`, to, subject, html });
}

function subjectFor(events) {
  const count = (t) => events.filter((e) => e.type === t).length;
  return `🔔 ${[
    count('minimo') && `${count('minimo')} novo(s) menor(es) preço(s)`,
    count('queda') && `${count('queda')} queda(s)`,
    count('promocao') && `${count('promocao')} promoção(ões)`,
    count('voltou') && `${count('voltou')} volta(s) ao estoque`,
    count('aumento') && `${count('aumento')} aumento(s)`,
  ]
    .filter(Boolean)
    .join(', ')}`;
}

// Regiões de cada loja, por produto (para mandar a cada pessoa só o que é da região dela).
async function storeRegions(productIds) {
  const rows = await q('SELECT product_id, store_id, regions FROM offers WHERE product_id = ANY($1)', [productIds]);
  return new Map(rows.map((r) => [`${r.product_id}|${r.store_id}`, JSON.parse(r.regions)]));
}

// Envia as novidades ainda não enviadas: um e-mail por pessoa, só com os produtos da lista dela
// e as lojas da região dela. Retorna quantas novidades saíram.
export async function sendAlertEmail(settings) {
  const types = ['minimo', 'queda', 'promocao', 'voltou', ...(settings.notificarAumentos ? ['aumento'] : [])];
  const cutoff = new Date(Date.now() - 2 * 864e5).toISOString();
  // Novidades antigas que nunca saíram (ex.: e-mail não configurado) não viram enxurrada depois.
  await q('UPDATE events SET emailed = 2 WHERE emailed = 0 AND created_at < $1', [cutoff]);

  const pending = await q('SELECT * FROM events WHERE emailed = 0 AND type = ANY($1) ORDER BY id', [types]);
  if (!pending.length || !emailConfigured()) return 0;

  const unique = dedupeEvents(pending);
  const [users, watched, allProducts, regionsOf] = await Promise.all([
    listUsers(),
    watchersByProduct(),
    listProducts(),
    storeRegions([...new Set(unique.map((e) => e.product_id))]),
  ]);
  const inRegion = (e, region) => {
    if (region === 'todas') return true;
    const regs = regionsOf.get(`${e.product_id}|${e.store_id}`) ?? ['*'];
    return regs.includes('*') || regs.includes(region);
  };

  let sent = 0;
  const errors = [];
  for (const u of users) {
    const mine = watched.get(u.id);
    const events = unique.filter((e) => mine?.has(e.product_id) && inRegion(e, u.region));
    if (!events.length) continue;
    const products = allProducts.filter((p) => events.some((e) => e.product_id === p.id));
    const sections = (await withOffers(products, true, u.region)).map((s) => ({ ...s, events: events.filter((e) => e.product_id === s.product.id) }));
    try {
      await send(u.email, subjectFor(events), buildHtml(sections, 'Novidades nos seus produtos'));
      sent += events.length;
    } catch (err) {
      errors.push(`${u.email}: ${err.message}`);
    }
  }
  // Marca como enviadas mesmo se alguém falhou: reenviar repetiria o e-mail de quem já recebeu.
  await q('UPDATE events SET emailed = 1 WHERE id = ANY($1)', [pending.map((e) => e.id)]);
  if (errors.length) throw new Error(`Falha no envio para ${errors.join(' | ')}`);
  return sent;
}

// HTML do e-mail de resumo da pessoa, para conferir no navegador.
export async function previewSummaryHtml(user) {
  const sections = [];
  for (const s of await withOffers(await listProducts({ onlyActive: true, userId: user.id }), false, user.region)) {
    sections.push({ ...s, events: dedupeEvents(await q('SELECT * FROM events WHERE product_id = $1 ORDER BY id DESC LIMIT 15', [s.product.id])).slice(0, 5) });
  }
  return buildHtml(sections, 'Pré-visualização do e-mail');
}

// Resumo completo do ranking atual da pessoa (botão "enviar resumo" / teste de configuração).
export async function sendSummaryEmail(user) {
  if (!emailConfigured()) throw new Error('E-mail não configurado: preencha SMTP_USER e SMTP_PASS (arquivo .env ou variáveis da Vercel)');
  const sections = (await withOffers(await listProducts({ onlyActive: true, userId: user.id }), false, user.region)).map((s) => ({ ...s, events: [] }));
  await send(user.email, '📊 Resumo do Radar de Preços', buildHtml(sections, 'Resumo dos seus produtos'));
}

// Link de acesso (login ou convite).
export async function sendLoginEmail(user, link, { invite = false, invitedBy = null, ttlText }) {
  const title = invite ? 'Você foi convidado para o Radar de Preços' : 'Seu link de acesso';
  const intro = invite
    ? `${invitedBy ? `${esc(invitedBy)} convidou você` : 'Você foi convidado'} para acompanhar preços no Radar de Preços. Você escolhe os produtos e recebe um e-mail quando o preço cair, entrar em promoção ou voltar ao estoque.`
    : 'Clique no botão para entrar no Radar de Preços. Se não foi você que pediu, ignore este e-mail.';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f1;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <div style="font-size:13px;color:#52514e;letter-spacing:.04em;text-transform:uppercase;font-weight:600">Radar de Preços</div>
    <div style="background:#fff;border-radius:12px;padding:24px;margin-top:12px;border:1px solid #e1e0d9">
      <h1 style="margin:0 0 12px;font-size:20px;color:#0b0b0b">${esc(title)}</h1>
      <p style="color:#52514e;font-size:15px;line-height:1.5;margin:0 0 20px">${intro}</p>
      <a href="${esc(link)}" style="display:inline-block;background:#1c5cab;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">Entrar no Radar de Preços</a>
      <p style="color:#898781;font-size:12px;margin:20px 0 0">O link vale por ${esc(ttlText)} e funciona uma vez. Depois disso, peça outro na tela de entrada.</p>
    </div>
  </div></body></html>`;
  await send(user.email, invite ? '✉️ Convite para o Radar de Preços' : '🔑 Seu link de acesso ao Radar de Preços', html);
}
