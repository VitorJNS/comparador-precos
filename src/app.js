// API do painel. O mesmo handler roda no servidor local (src/server.js) e na
// função da Vercel (api/index.js).
//
// Segurança:
//   - Login por link no e-mail (ver auth.js). Só entra quem foi convidado; cada pessoa
//     vê e recebe alertas só dos produtos da própria lista. Quem administra convida pessoas.
//   - CRON_SECRET: protege as rotas /api/cron/* (a Vercel envia "Authorization: Bearer <CRON_SECRET>").

import { timingSafeEqual } from 'node:crypto';
import {
  q, one, createUser, deleteUser, getProduct, getUser, getUserByEmail, linkProduct, listProducts, listUsers,
  loadSettings, normEmail, saveProduct, setProductImage, unlinkProduct, updateUser, userHasProduct,
} from './db.js';
import { getProgress, runCollection, runMarketSlice, startRun } from './collector.js';
import { MARKETS, UNSUPPORTED, findProductImage } from './markets/index.js';
import { CATEGORIES, guessCategory, isCategory } from './categories.js';
import { emailConfigured, panelUrl, previewSummaryHtml, sendLoginEmail, sendSummaryEmail } from './notifier.js';
import { INVITE_TTL_DAYS, LOGIN_TTL_MIN, clearCookie, consumeLoginToken, createLoginToken, currentUser, sessionCookie } from './auth.js';
import {
  getOffers, getOffersByProduct, historicMin, historicMins, history, productImage, productImages,
  purgeNonMatching, rankOffers, recentEvents, sparkSeries,
} from './queries.js';

const ON_VERCEL = !!process.env.VERCEL;
// Banco de produção (Neon): a coleta é agendada pelo GitHub Actions, mesmo rodando no PC.
const REMOTE_SCHEDULE = ON_VERCEL || !!process.env.DATABASE_URL;
// Cada execução na Vercel coleta até ~4 min (limite do plano Hobby é 5) e passa o resto adiante.
const SLICE_MS = Number(process.env.RADAR_SLICE_MS) || 240 * 1000;

// ---------- respostas ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// Aceita JSON e também formulário (a página /api/entrar funciona sem JavaScript).
async function readBody(req) {
  if (req.body !== undefined && typeof req.body !== 'string') return req.body ?? {};
  let raw = req.body ?? '';
  if (req.body === undefined) for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  if (String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(html);
}

// ---------- autenticação ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Gera o link de acesso e manda por e-mail. Sem e-mail configurado (só no PC), devolve o link
// para aparecer na tela. Retorna { sent, devLink } ou { limited: true }.
async function deliverLoginLink(user, { invite = false, invitedBy = null } = {}) {
  const ttlMs = invite ? INVITE_TTL_DAYS * 864e5 : LOGIN_TTL_MIN * 60e3;
  const token = await createLoginToken(user.id, ttlMs);
  if (!token) return { limited: true };
  const link = `${panelUrl()}/api/entrar?token=${encodeURIComponent(token)}`;
  if (!emailConfigured()) {
    if (ON_VERCEL) throw new Error('E-mail não configurado: preencha SMTP_USER e SMTP_PASS nas variáveis da Vercel');
    console.log(`Link de acesso para ${user.email}: ${link}`);
    return { sent: false, devLink: link };
  }
  await sendLoginEmail(user, link, { invite, invitedBy, ttlText: invite ? `${INVITE_TTL_DAYS} dias` : `${LOGIN_TTL_MIN} minutos` });
  return { sent: true };
}

// Página aberta pelo link do e-mail. O token só é usado no clique (POST): leitores de link
// que alguns provedores de e-mail usam para checar segurança abrem com GET e não gastariam o link.
function enterPage(token, error = '') {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Entrar · Radar de Preços</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="enter-page"><div class="panel enter-card">
  <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 17l5-6 4 3 7-8" /></svg></span>
  <h1>Radar de Preços</h1>
  ${error
    ? `<p class="form-error" role="alert">${esc(error)}</p><a class="btn btn-primary" href="/">Pedir um novo link</a>`
    : `<p class="muted">Toque no botão para entrar.</p>
       <form method="post" action="/api/entrar"><input type="hidden" name="token" value="${esc(token)}"><button class="btn btn-primary" type="submit">Entrar</button></form>`}
</div></main></body></html>`;
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
  // Sempre o domínio de produção: o cron da Vercel chama a URL da própria publicação
  // (xxx-hash.vercel.app), que fica atrás da proteção de login da Vercel e recusa os encadeamentos.
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
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
    const results = await Promise.allSettled(MARKETS.map((m) => dispatchMarket(base, r.runId, m.id)));
    const failed = results.filter((x) => x.status === 'rejected').map((x) => x.reason.message);
    if (failed.length === MARKETS.length) {
      // Nenhuma loja começou: encerra a coleta para não travar as próximas.
      await q(`UPDATE runs SET status = 'erro', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), r.runId]);
      throw new Error(failed[0]);
    }
    if (failed.length) console.error('Coleta', r.runId, failed.join(' | '));
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
  if (REMOTE_SCHEDULE) {
    // GitHub Actions às 03, 09, 15 e 21 UTC (00h, 06h, 12h, 18h em Brasília); o cron da Vercel também às 09 UTC.
    const now = new Date();
    for (let add = 0; add < 30; add++) {
      const d = new Date(now);
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() + add);
      if (d > now && [3, 9, 15, 21].includes(d.getUTCHours())) return d;
    }
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
    intervalHours: REMOTE_SCHEDULE ? 6 : (loadSettings().intervaloHoras ?? 6),
    hosted: REMOTE_SCHEDULE,
    markets: MARKETS.map((m) => {
      const r = markets.find((x) => x.market === m.id);
      return { id: m.id, name: m.name, kind: m.kind, site: m.site, status: r?.status ?? 'pendente', offers: r?.offers ?? 0, error: r?.error ?? null, ms: r?.ms ?? null };
    }),
    unsupported: UNSUPPORTED,
  };
}

async function overview(region, user) {
  const [products, offersBy, sparks, mins, images, runs, progress, events, drops, users] = await Promise.all([
    listProducts({ userId: user.id }),
    getOffersByProduct(region),
    sparkSeries(region, 60),
    historicMins(),
    productImages(),
    runsSummary(),
    getProgress(),
    recentEvents(30, { userId: user.id }),
    one(
      `SELECT COUNT(*)::int AS n FROM events WHERE type IN ('queda','minimo') AND created_at >= $1
       AND product_id IN (SELECT product_id FROM user_products WHERE user_id = $2)`,
      [new Date(Date.now() - 7 * 864e5).toISOString(), user.id],
    ),
    user.isAdmin ? listUsers() : null,
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
    categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
    runs,
    progress,
    events,
    stats: { drops7d: drops.n, promos: cards.reduce((n, p) => n + p.promoCount, 0) },
    email: { configured: emailConfigured(), to: user.email },
    me: user,
    users,
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
    recentEvents(40, { productId: id }),
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
    // "auto" (ou vazio) = sugerida pelo nome; ver categories.js.
    category: body.category !== undefined ? (isCategory(body.category) ? body.category : guessCategory(name)) : (existing.category ?? guessCategory(name)),
  };
}

// Procura uma imagem do produto nas lojas e guarda (até ~12 s; sem imagem não é erro).
async function fillImage(product) {
  const image = await findProductImage(product).catch(() => null);
  if (image) await setProductImage(product.id, image);
  return image;
}

// ---------- rotas ----------

export async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
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

  // ----- entrada (sem sessão) -----

  // Pede o link de acesso. A resposta é a mesma para e-mail cadastrado ou não (não revela quem usa o app).
  if (parts[1] === 'login' && method === 'POST') {
    const email = normEmail((await readBody(req)).email);
    if (!isEmail(email)) return send(res, 400, { error: 'Informe um e-mail válido' });
    let user = await getUserByEmail(email);
    // Banco novo no PC, sem ninguém cadastrado: o primeiro e-mail vira o administrador.
    if (!user && !ON_VERCEL && !(await one('SELECT 1 AS x FROM users LIMIT 1'))) user = await createUser({ email, isAdmin: true });
    if (!user) return send(res, 200, { ok: true });
    const r = await deliverLoginLink(user);
    if (r.limited) return send(res, 429, { error: 'Muitos pedidos de link. Espere alguns minutos e tente de novo.' });
    return send(res, 200, { ok: true, ...(r.devLink ? { devLink: r.devLink } : {}) });
  }
  if (parts[1] === 'entrar') {
    if (method === 'GET') return sendHtml(res, 200, enterPage(url.searchParams.get('token') ?? ''));
    if (method === 'POST') {
      const user = await consumeLoginToken((await readBody(req)).token);
      if (!user) return sendHtml(res, 400, enterPage('', 'Este link venceu ou já foi usado.'));
      return sendHtml(res, 303, '', { Location: '/', 'Set-Cookie': await sessionCookie(user.id, ON_VERCEL) });
    }
  }
  if (parts[1] === 'logout') return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(ON_VERCEL) });

  const me = await currentUser(req);
  if (!me) return send(res, 401, { error: 'login' });
  // Região: a escolhida na tela; sem escolha, a do perfil da pessoa.
  const region = url.searchParams.get('regiao') || me.region || 'todas';

  if (method === 'GET' && parts[1] === 'overview') return send(res, 200, await overview(region, me));
  if (method === 'GET' && parts[1] === 'progress') return send(res, 200, await getProgress());
  if (method === 'POST' && parts[1] === 'run') return send(res, 202, await startCollection(req, 'manual'));

  // ----- perfil -----
  if (parts[1] === 'me' && method === 'PUT') {
    const body = await readBody(req);
    const regions = loadSettings().regioes.map((r) => r.id);
    const region = body.region === 'todas' || regions.includes(body.region) ? body.region : undefined;
    const name = body.name !== undefined ? String(body.name).trim().slice(0, 60) : undefined;
    await updateUser(me.id, { name, region });
    return send(res, 200, await getUser(me.id));
  }

  // ----- pessoas (só administrador) -----
  if (parts[1] === 'users') {
    if (!me.isAdmin) return send(res, 403, { error: 'Só quem administra pode gerenciar pessoas' });
    const id = parts[2] ? Number(parts[2]) : null;
    if (method === 'GET' && !id) return send(res, 200, await listUsers());
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      const email = normEmail(body.email);
      if (!isEmail(email)) return send(res, 400, { error: 'Informe um e-mail válido' });
      if (await getUserByEmail(email)) return send(res, 409, { error: 'Esse e-mail já está cadastrado' });
      const user = await createUser({ email, name: String(body.name ?? '').trim().slice(0, 60) });
      const r = await deliverLoginLink(user, { invite: true, invitedBy: me.name || me.email });
      return send(res, 201, { user, sent: !!r.sent, ...(r.devLink ? { devLink: r.devLink } : {}) });
    }
    const target = id && (await getUser(id));
    if (!target) return send(res, 404, { error: 'Pessoa não encontrada' });
    if (method === 'POST' && parts[3] === 'convite') {
      const r = await deliverLoginLink(target, { invite: true, invitedBy: me.name || me.email });
      if (r.limited) return send(res, 429, { error: 'Muitos convites para essa pessoa. Espere uma hora.' });
      return send(res, 200, { sent: !!r.sent, ...(r.devLink ? { devLink: r.devLink } : {}) });
    }
    if (method === 'DELETE' && !parts[3]) {
      if (target.id === me.id) return send(res, 400, { error: 'Você não pode remover a si mesmo' });
      await deleteUser(target.id);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Rota não encontrada' });
  }

  if (method === 'GET' && parts[1] === 'email-preview') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(await previewSummaryHtml(me));
  }
  if (method === 'POST' && parts[1] === 'email-teste') {
    await sendSummaryEmail(me);
    return send(res, 200, { ok: true });
  }

  if (parts[1] === 'products') {
    const id = parts[2] ? Number(parts[2]) : null;
    if (method === 'POST' && !id) {
      const newId = await saveProduct(validateProduct(await readBody(req)));
      await linkProduct(me.id, newId);
      const image = await fillImage(await getProduct(newId));
      return send(res, 201, { id: newId, image });
    }
    // Só quem tem o produto na lista mexe nele (quem administra também, para ajudar a ajustar a busca).
    const existing = id && (me.isAdmin || (await userHasProduct(me.id, id))) && (await getProduct(id));
    if (!existing) return send(res, 404, { error: 'Produto não encontrado' });
    if (method === 'GET' && !parts[3]) return send(res, 200, await productDetail(id, region));

    if (method === 'PUT' && !parts[3]) {
      await saveProduct(validateProduct(await readBody(req), existing));
      const updated = await getProduct(id);
      const removed = await purgeNonMatching(updated);
      if (!(await productImage(id))) await fillImage(updated);
      return send(res, 200, { ok: true, removed });
    }
    if (method === 'DELETE' && !parts[3]) {
      // Sai da lista de quem removeu; o produto só é apagado se mais ninguém monitora.
      const others = await unlinkProduct(me.id, id);
      return send(res, 200, { ok: true, others });
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
