// Envio de alertas por e-mail (SMTP; pensado para Gmail com "senha de app").

import nodemailer from 'nodemailer';
import { q, listProducts } from './db.js';
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

// Carrega as ofertas de cada produto; resumos só listam os que têm alguma disponível.
async function withOffers(products, keepEmpty = false) {
  const out = [];
  for (const p of products) {
    const offers = await getOffers(p.id);
    if (offers.length || keepEmpty) out.push({ product: p, offers });
  }
  return out;
}

// Endereço do painel: na Vercel, o domínio de produção; localmente, localhost.
const panelUrl = () =>
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

/** Destinatários: EMAIL_PARA aceita vários e-mails separados por vírgula, ponto e vírgula ou espaço. */
export function recipients() {
  const list = String(process.env.EMAIL_PARA || process.env.SMTP_USER || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
  return [...new Set(list)];
}

async function send(subject, html) {
  const to = recipients();
  await transport().sendMail({
    from: `"Radar de Preços" <${process.env.SMTP_USER}>`,
    // Com mais de um destinatário, vão em cópia oculta: ninguém vê o e-mail dos outros.
    ...(to.length > 1 ? { to: process.env.SMTP_USER, bcc: to } : { to }),
    subject,
    html,
  });
}

// Envia as novidades ainda não enviadas. Retorna quantas foram incluídas.
export async function sendAlertEmail(settings) {
  const types = ['minimo', 'queda', 'promocao', 'voltou', ...(settings.notificarAumentos ? ['aumento'] : [])];
  const cutoff = new Date(Date.now() - 2 * 864e5).toISOString();
  // Novidades antigas que nunca saíram (ex.: e-mail não configurado) não viram enxurrada depois.
  await q('UPDATE events SET emailed = 2 WHERE emailed = 0 AND created_at < $1', [cutoff]);

  const pending = await q('SELECT * FROM events WHERE emailed = 0 AND type = ANY($1) ORDER BY id', [types]);
  if (!pending.length || !emailConfigured()) return 0;

  const unique = dedupeEvents(pending);
  const withEvents = (await listProducts()).filter((p) => unique.some((e) => e.product_id === p.id));
  const sections = (await withOffers(withEvents, true)).map((s) => ({ ...s, events: unique.filter((e) => e.product_id === s.product.id) }));

  const count = (t) => unique.filter((e) => e.type === t).length;
  const parts = [
    count('minimo') && `${count('minimo')} novo(s) menor(es) preço(s)`,
    count('queda') && `${count('queda')} queda(s)`,
    count('promocao') && `${count('promocao')} promoção(ões)`,
    count('voltou') && `${count('voltou')} volta(s) ao estoque`,
    count('aumento') && `${count('aumento')} aumento(s)`,
  ].filter(Boolean);

  await send(`🔔 ${parts.join(', ')}`, buildHtml(sections, 'Novidades nos seus produtos'));
  await q('UPDATE events SET emailed = 1 WHERE id = ANY($1)', [pending.map((e) => e.id)]);
  return unique.length;
}

// HTML do e-mail de resumo, para conferir no navegador.
export async function previewSummaryHtml() {
  const sections = [];
  for (const s of await withOffers(await listProducts({ onlyActive: true }))) {
    sections.push({ ...s, events: dedupeEvents(await q('SELECT * FROM events WHERE product_id = $1 ORDER BY id DESC LIMIT 15', [s.product.id])).slice(0, 5) });
  }
  return buildHtml(sections, 'Pré-visualização do e-mail');
}

// Resumo completo do ranking atual (botão "enviar resumo" / teste de configuração).
export async function sendSummaryEmail() {
  if (!emailConfigured()) throw new Error('E-mail não configurado: preencha SMTP_USER e SMTP_PASS (arquivo .env ou variáveis da Vercel)');
  const sections = (await withOffers(await listProducts({ onlyActive: true }))).map((s) => ({ ...s, events: [] }));
  await send('📊 Resumo do Radar de Preços', buildHtml(sections, 'Resumo dos seus produtos'));
}
