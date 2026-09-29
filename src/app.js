// API do painel. O mesmo handler roda no servidor local (src/server.js) e na
// função da Vercel (api/index.js).
//
// Segurança:
//   - PAINEL_SENHA: se definida, a API exige login (cookie assinado). Obrigatória na Vercel.
//   - CRON_SECRET: protege as rotas /api/cron/* (a Vercel envia "Authorization: Bearer <CRON_SECRET>").

import { createHmac, timingSafeEqual } from 'node:crypto';
import { q, one, getProduct, listProducts, loadSettings, saveProduct } from './db.js';
import { getProgress, runCollection, runMarketSlice, startRun } from './collector.js';
import { MARKETS, UNSUPPORTED } from './markets/index.js';
import { emailConfigured, previewSummaryHtml, sendSummaryEmail } from './notifier.js';
import {
  getOffers, getOffersByProduct, historicMin, historicMins, history, productImage, productImages,
  purgeNonMatching, rankOffers, recentEvents, sparkSeries,
} from './queries.js';

const ON_VERCEL = !!process.env.VERCEL;
// Cada execução na Vercel coleta até ~4 min (limite do plano Hobby é 5) e passa o resto adiante.
const SLICE_MS = Number(process.env.RADAR_SLICE_MS) || 240 * 1000;

// ---------- respostas ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? (req.body ? JSON.parse(req.body) : {}) : req.body ?? {};
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// ---------- autenticação ----------

const COOKIE = 'radar_sessao';
const sign = (value) => createHmac('sha256', process.env.PAINEL_SENHA).update(value).digest('hex');

function sessionToken() {
  const exp = Date.now() + 30 * 864e5;
  return `${exp}.${sign(String(exp))}`;
}

function validSession(req) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !ON_VERCEL; // localmente dá para testar sem segredo
  const a = Buffer.from(req.headers.authorization ?? '');
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- coleta na Vercel: uma execução por loja, encadeada ----------

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] ?? (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
}

// Pede uma nova execução da loja (a resposta 202 volta na hora; o trabalho segue lá).
async function dispatchMarket(base, runId, market) {
  const res = await fetch(`${base}/api/cron/loja?run=${runId}&loja=${market}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  if (!res.ok) throw new Error(`Não consegui iniciar ${market}: HTTP ${res.status}`);
}

// Mantém a função viva depois da resposta até o trabalho terminar (limite de 5 min).
async function background(promise) {
  if (!ON_VERCEL) return void promise.catch((e) => console.error(e));
  const { waitUntil } = await import('@vercel/functions');
  waitUntil(promise.catch((e) => console.error(e)));
}

async function startCollection(req, trigger) {
  if (!ON_VERCEL) {
    const r = await runCollection(trigger);
    return { started: r.started, runId: r.runId };
  }
  const r = await startRun(trigger);
  if (r.started) {
    const base = baseUrl(req);
    await Promise.all(MARKETS.map((m) => dispatchMarket(base, r.runId, m.id)));
  }
  return r;
}

// ---------- dados do painel ----------

let lastRunCache = null;
async function lastRun() {
  return (lastRunCache = await one(`SELECT * FROM runs WHERE status NOT IN ('running', 'finalizando') ORDER BY id DESC LIMIT 1`));
}

async function nextRunAt() {
  const settings = loadSettings();
  const last = lastRunCache ?? (await lastRun());
  if (ON_VERCEL) {
    // Cron diário do vercel.json (09:00 UTC = 06:00 em Brasília).
    const d = new Date();
    d.setUTCHours(9, 0, 0, 0);
    if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (!last) return new Date();
  return new Date(new Date(last.started_at).getTime() + (settings.intervaloHoras ?? 6) * 3600e3);
}

export async function localScheduleTick() {
  const p = await getProgress();
  if (!p.running && (await nextRunAt()) <= new Date()) await runCollection('agendado');
}

async function runsSummary() {
  const last = await lastRun();
  const markets = last ? await q('SELECT * FROM run_markets WHERE run_id = $1', [last.id]) : [];
  return {
    last,
    next: (await nextRunAt()).toISOString(),
    intervalHours: ON_VERCEL ? 24 : (loadSettings().intervaloHoras ?? 6),
    hosted: ON_VERCEL,
    markets: MARKETS.map((m) => {
      const r = markets.find((x) => x.market === m.id);
      return { id: m.id, name: m.name, kind: m.kind, site: m.site, status: r?.status ?? 'pendente', offers: r?.offers ?? 0, error: r?.error ?? null, ms: r?.ms ?? null };
    }),
    unsupported: UNSUPPORTED,
  };
}

async function overview(region) {
  const [products, offersBy, sparks, mins, images, runs, progress, events, drops] = await Promise.all([
    listProducts(),
    getOffersByProduct(region),
    sparkSeries(region, 60),
    historicMins(),
    productImages(),
    runsSummary(),
    getProgress(),
    recentEvents(30),
    one(`SELECT COUNT(*)::int AS n FROM events WHERE type IN ('queda','minimo') AND created_at >= $1`, [
      new Date(Date.now() - 7 * 864e5).toISOString(),
    ]),
  ]);
  const cards = products.map((p) => {
    const ranked = rankOffers(offersBy.get(p.id) ?? []);
    return {
      ...p,
      best: ranked[0] ?? null,
      image: ranked[0]?.image ?? images.get(p.id) ?? null,
      marketsWithOffer: new Set(ranked.map((g) => g.market)).size,
      storeCount: ranked.reduce((n, g) => n + g.stores.length, 0),
      promoCount: ranked.filter((g) => g.promo).length,
      historicMin: mins.get(p.id) ?? null,
      spark: sparks.get(p.id) ?? [],
    };
  });
  return {
    products: cards,
    regions: loadSettings().regioes.map((r) => ({ id: r.id, name: r.nome, ceps: r.ceps })),
    runs,
    progress,
    events,
    stats: { drops7d: drops.n, promos: cards.reduce((n, p) => n + p.promoCount, 0) },
    email: { configured: emailConfigured(), to: process.env.EMAIL_PARA || process.env.SMTP_USER || null },
  };
}

async function productDetail(id, region) {
  const p = await getProduct(id);
  if (!p) return null;
  const [offers, hist, min, candidates, events, image] = await Promise.all([
    getOffers(id, region),
    history(id, region, 180),
    historicMin(id),
    q('SELECT * FROM candidates WHERE product_id = $1 ORDER BY market, price', [id]),
    recentEvents(40, id),
    productImage(id),
  ]);
  return {
    product: { ...p, image },
    ranking: rankOffers(offers),
    history: hist,
    historicMin: min,
    candidates,
    events,
    markets: MARKETS.map((m) => ({ id: m.id, name: m.name })),
  };
}

// ---------- validação de produto ----------

const cleanList = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);

// Aceita 3500, "3500", "3.500" ou "3.500,00". Vazio/zero = sem limite.
function parseBRL(v) {
  if (typeof v === 'number') return v > 0 ? v : null;
  const s = String(v ?? '').replace(/[^\d.,]/g, '');
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}\b)/g, ''));
  return n > 0 ? n : null;
}

function validateProduct(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? '').trim();
  const query = String(body.query ?? existing.query ?? name).trim();
  if (!name) throw new Error('Informe o nome do produto');
  return {
    ...existing,
    name,
    query,
    include: body.include !== undefined ? cleanList(body.include) : (existing.include ?? cleanList(query.split(' '))),
    exclude: body.exclude !== undefined ? cleanList(body.exclude) : (existing.exclude ?? []),
    eans: body.eans !== undefined ? cleanList(body.eans) : (existing.eans ?? []),
    active: body.active !== undefined ? !!body.active : (existing.active ?? true),
    maxPrice: body.maxPrice !== undefined ? parseBRL(body.maxPrice) : (existing.maxPrice ?? null),
    channels: body.channels !== undefined ? (body.channels === 'todos' ? 'todos' : 'mercados') : (existing.channels ?? 'mercados'),
  };
}

// ---------- rotas ----------

export async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const region = url.searchParams.get('regiao') || 'todas';
  const method = req.method;

  // Rotas de coleta agendada (cron da Vercel e encadeamento entre execuções).
  if (parts[1] === 'cron') {
    if (!cronAuthorized(req)) return send(res, 401, { error: 'Não autorizado' });
    if (parts[2] === 'coletar') return send(res, 202, await startCollection(req, 'agendado'));
    if (parts[2] === 'loja') {
      const runId = Number(url.searchParams.get('run'));
      const market = url.searchParams.get('loja');
      const base = baseUrl(req);
      const deadline = Date.now() + SLICE_MS;
      await background(
        runMarketSlice(runId, market, { deadline }).then((r) => (r.finished ? null : dispatchMarket(base, runId, market))),
      );
      return send(res, 202, { ok: true });
    }
    return send(res, 404, { error: 'Rota não encontrada' });
  }

  // Login do painel.
  if (ON_VERCEL && !process.env.PAINEL_SENHA) return send(res, 500, { error: 'Defina PAINEL_SENHA nas variáveis da Vercel' });
  if (parts[1] === 'login' && method === 'POST') {
    const { senha } = await readBody(req);
    const a = Buffer.from(String(senha ?? ''));
    const b = Buffer.from(process.env.PAINEL_SENHA ?? '');
    if (!process.env.PAINEL_SENHA || (a.length === b.length && timingSafeEqual(a, b))) {
      const secure = ON_VERCEL ? '; Secure' : '';
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(process.env.PAINEL_SENHA ? sessionToken() : '')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`,
      });
    }
    return send(res, 401, { error: 'Senha incorreta' });
  }
  if (parts[1] === 'logout') return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
  if (process.env.PAINEL_SENHA && !validSession(req)) return send(res, 401, { error: 'login' });

  if (method === 'GET' && parts[1] === 'overview') return send(res, 200, await overview(region));
  if (method === 'GET' && parts[1] === 'progress') return send(res, 200, await getProgress());
  if (method === 'POST' && parts[1] === 'run') return send(res, 202, await startCollection(req, 'manual'));

  if (method === 'GET' && parts[1] === 'email-preview') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(await previewSummaryHtml());
  }
  if (method === 'POST' && parts[1] === 'email-teste') {
    await sendSummaryEmail();
    return send(res, 200, { ok: true });
  }

  if (parts[1] === 'products') {
    const id = parts[2] ? Number(parts[2]) : null;
    if (method === 'GET' && id) {
      const d = await productDetail(id, region);
      return d ? send(res, 200, d) : send(res, 404, { error: 'Produto não encontrado' });
    }
    if (method === 'POST' && !id) {
      const newId = await saveProduct(validateProduct(await readBody(req)));
      return send(res, 201, { id: newId });
    }
    const existing = id && (await getProduct(id));
    if (!existing) return send(res, 404, { error: 'Produto não encontrado' });

    if (method === 'PUT' && !parts[3]) {
      await saveProduct(validateProduct(await readBody(req), existing));
      const removed = await purgeNonMatching(await getProduct(id));
      return send(res, 200, { ok: true, removed });
    }
    if (method === 'DELETE' && !parts[3]) {
      await q('DELETE FROM products WHERE id = $1', [id]);
      return send(res, 200, { ok: true });
    }
    // Aceitar/descartar manualmente um item encontrado em um site.
    if (method === 'POST' && (parts[3] === 'aceitar' || parts[3] === 'descartar')) {
      // key: um item; keys: vários (ex.: as voltagens 127V/220V de uma mesma linha do ranking).
      const body = await readBody(req);
      const keys = [...new Set([...(body.keys ?? []), body.key].filter(Boolean))];
      if (!keys.length) return send(res, 400, { error: 'key obrigatório' });
      const accept = parts[3] === 'aceitar';
      for (const key of keys) {
        existing.accepted = existing.accepted.filter((k) => k !== key);
        existing.rejected = existing.rejected.filter((k) => k !== key);
        (accept ? existing.accepted : existing.rejected).push(key);
      }
      if (accept) await q('DELETE FROM candidates WHERE product_id = $1 AND ext_key = ANY($2)', [id, keys]);
      await saveProduct(existing);
      if (!accept) await purgeNonMatching(await getProduct(id)); // some do ranking e do histórico
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'Rota não encontrada' });
}

export async function handle(req, res, url) {
  try {
    return await handleApi(req, res, url);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
}
