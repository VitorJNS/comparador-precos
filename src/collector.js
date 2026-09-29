// Coleta de preços, em partes que podem rodar em execuções separadas:
//   startRun()                  cria a coleta e uma linha por loja em run_markets
//   runMarketSlice(run, loja)   coleta os produtos daquela loja até terminar ou até o prazo
//                               (guarda next_index para continuar em outra execução)
//   finalização                 a última loja a terminar detecta novos mínimos e envia o e-mail
// Localmente, runCollection() roda tudo de uma vez no mesmo processo.

import { q, one, insertMany, listProducts, loadSettings } from './db.js';
import { setMinGap } from './http.js';
import { normalize } from './matcher.js';
import { MARKETS, marketsFor } from './markets/index.js';
import { sendAlertEmail } from './notifier.js';

const now = () => new Date().toISOString();
const isPromo = (price, list) => !!(list && price && list > price * 1.01);
const STUCK_MS = 30 * 60 * 1000; // coleta "rodando" há mais que isso = interrompida
const DONE = ['ok', 'parcial', 'erro'];

const log = (msg) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);

function detectEvents(runId, product, market, prev, o, settings, at) {
  if (!prev) return [];
  const out = [];
  const add = (type, oldPrice) =>
    out.push([runId, product.id, market, o.storeId, o.storeName, type, oldPrice, o.price, o.listPrice ?? null, o.url ?? null, at]);

  const minDrop = (settings.quedaMinimaPercentual ?? 0.5) / 100;
  if (o.available && !prev.available) add('voltou', prev.price);
  else if (o.available && prev.price && o.price < prev.price * (1 - minDrop)) add('queda', prev.price);
  else if (o.available && prev.available && prev.price && o.price > prev.price * 1.005) add('aumento', prev.price);

  if (o.available && isPromo(o.price, o.listPrice) && !isPromo(prev.price, prev.list_price)) add('promocao', prev.price);
  return out;
}

// Um descarte só vale revisão se tiver o termo principal (ex.: a marca) e mais
// alguma palavra da busca (ex.: "geladeira"), para não listar ferro de passar da mesma marca.
function isRelevantCandidate(product, title) {
  const text = normalize(title);
  const main = normalize(product.include[0]?.split('|')[0] ?? '');
  if (main.trim() && !text.includes(main)) return false;
  const others = normalize(product.query).trim().split(' ').filter((w) => w.length >= 2 && !main.includes(` ${w} `));
  return !others.length || others.some((w) => text.includes(` ${w} `));
}

const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Ofertas acima do preço máximo do produto viram "descartadas" (com o motivo).
function applyMaxPrice(product, result) {
  if (!product.maxPrice) return { ...result, over: [] };
  const offers = [];
  const over = [];
  for (const o of result.offers) (o.price > product.maxPrice ? over : offers).push(o);
  const reason = `Acima do limite de ${brl(product.maxPrice)}`;
  return { offers, over, candidates: [...over.map((o) => ({ ...o, reason })), ...result.candidates] };
}

const OFFER_COLS = ['product_id', 'market', 'store_id', 'store_name', 'regions', 'title', 'url', 'image', 'ext_key', 'ean',
  'price', 'list_price', 'available', 'note', 'first_seen', 'seen_at', 'changed_at'];
const OFFER_UPSERT = `ON CONFLICT (product_id, market, store_id) DO UPDATE SET
  store_name=excluded.store_name, regions=excluded.regions, title=excluded.title, url=excluded.url,
  image=excluded.image, ext_key=excluded.ext_key, ean=excluded.ean, price=excluded.price,
  list_price=excluded.list_price, available=excluded.available, note=excluded.note,
  seen_at=excluded.seen_at, changed_at=excluded.changed_at`;
const EVENT_COLS = ['run_id', 'product_id', 'market', 'store_id', 'store_name', 'type', 'old_price', 'new_price', 'list_price', 'url', 'created_at'];

async function saveMarketResult(runId, product, market, rawResult, settings, at) {
  const result = applyMaxPrice(product, rawResult);
  // A mesma loja pode vir repetida de buscas diferentes: vale a última.
  const offers = [...new Map(result.offers.map((o) => [o.storeId, o])).values()];

  const prevRows = await q('SELECT * FROM offers WHERE product_id = $1 AND market = $2', [product.id, market]);
  const prevBy = new Map(prevRows.map((r) => [r.store_id, r]));

  if (result.over.length) {
    await q('DELETE FROM offers WHERE product_id = $1 AND market = $2 AND store_id = ANY($3)', [product.id, market, result.over.map((o) => o.storeId)]);
  }

  const offerRows = [];
  const obsRows = [];
  const eventRows = [];
  for (const o of offers) {
    const prev = prevBy.get(o.storeId);
    const changed = !prev || prev.price !== o.price || prev.list_price !== (o.listPrice ?? null) || !!prev.available !== o.available;
    offerRows.push([
      product.id, market, o.storeId, o.storeName, JSON.stringify(o.regions), o.title, o.url ?? null, o.image ?? null,
      o.extKey ?? null, o.ean ?? null, o.price, o.listPrice ?? null, o.available ? 1 : 0, o.note ?? null,
      prev?.first_seen ?? at, at, changed ? at : prev.changed_at,
    ]);
    obsRows.push([runId, product.id, market, o.storeId, o.price, o.listPrice ?? null, o.available ? 1 : 0, at]);
    eventRows.push(...detectEvents(runId, product, market, prev, o, settings, at));
  }
  await insertMany('offers', OFFER_COLS, offerRows, OFFER_UPSERT);
  await insertMany('observations', ['run_id', 'product_id', 'market', 'store_id', 'price', 'list_price', 'available', 'collected_at'], obsRows);
  await insertMany('events', EVENT_COLS, eventRows);

  // Resposta totalmente vazia costuma ser falha do site, não produto retirado: mantém o estado anterior.
  if (offers.length || result.candidates.length) {
    await q(
      `UPDATE offers SET available = 0, note = 'Não apareceu na última coleta' WHERE product_id = $1 AND market = $2 AND seen_at < $3`,
      [product.id, market, at],
    );
  }

  // Guarda só descartes que parecem relevantes (contêm o termo principal), para revisão manual.
  await q('DELETE FROM candidates WHERE product_id = $1 AND market = $2', [product.id, market]);
  const seen = new Set();
  const candRows = [];
  for (const c of result.candidates) {
    if (seen.has(c.extKey) || !isRelevantCandidate(product, c.title)) continue;
    seen.add(c.extKey);
    if (seen.size > 25) break;
    candRows.push([product.id, market, c.extKey, c.title, c.price ?? null, c.url ?? null, c.image ?? null, c.ean ?? null, c.reason ?? null]);
  }
  await insertMany('candidates', ['product_id', 'market', 'ext_key', 'title', 'price', 'url', 'image', 'ean', 'reason'], candRows, 'ON CONFLICT DO NOTHING');
  return offers.length;
}

// Novo menor preço histórico do produto (considerando só ofertas disponíveis).
async function detectNewLow(runId, product, runStartedAt, at) {
  const best = await one(
    'SELECT * FROM offers WHERE product_id = $1 AND available = 1 AND seen_at >= $2 ORDER BY price ASC LIMIT 1',
    [product.id, runStartedAt],
  );
  if (!best) return;
  const hist = await one('SELECT MIN(price) AS min FROM observations WHERE product_id = $1 AND available = 1 AND collected_at < $2', [
    product.id,
    runStartedAt,
  ]);
  if (hist?.min != null && best.price < hist.min - 0.005) {
    await insertMany('events', EVENT_COLS, [
      [runId, product.id, best.market, best.store_id, best.store_name, 'minimo', hist.min, best.price, best.list_price, best.url, at],
    ]);
  }
}

export async function startRun(trigger = 'agendado') {
  await q(`UPDATE runs SET status = 'interrompida', finished_at = $1 WHERE status IN ('running', 'finalizando') AND started_at < $2`, [
    now(),
    new Date(Date.now() - STUCK_MS).toISOString(),
  ]);
  const running = await one(`SELECT id FROM runs WHERE status IN ('running', 'finalizando') ORDER BY id DESC LIMIT 1`);
  if (running) return { started: false, runId: running.id };

  const products = await listProducts({ onlyActive: true });
  const run = await one('INSERT INTO runs (started_at, trigger) VALUES ($1, $2) RETURNING id', [now(), trigger]);
  await insertMany(
    'run_markets',
    ['run_id', 'market', 'status', 'total'],
    MARKETS.map((m) => [run.id, m.id, 'pendente', products.filter((p) => marketsFor(p).includes(m)).length]),
  );
  log(`Coleta #${run.id} iniciada (${products.length} produtos, ${MARKETS.length} lojas)`);
  return { started: true, runId: run.id };
}

// Coleta uma loja a partir de onde parou. Retorna { finished } — se false, chame de novo.
export async function runMarketSlice(runId, marketId, { deadline = Infinity } = {}) {
  const settings = loadSettings();
  setMinGap(settings.pausaEntreRequisicoesMs ?? 600);
  const m = MARKETS.find((x) => x.id === marketId);
  const rm = await one('SELECT * FROM run_markets WHERE run_id = $1 AND market = $2', [runId, marketId]);
  if (!m || !rm || DONE.includes(rm.status)) return { finished: true };

  const run = await one('SELECT started_at FROM runs WHERE id = $1', [runId]);
  const mine = (await listProducts({ onlyActive: true })).filter((p) => marketsFor(p).includes(m));
  const startedMs = Number(rm.started_ms ?? Date.now());
  const errors = rm.error ? rm.error.split(' | ') : [];
  let offers = rm.offers;
  let i = rm.next_index;
  await q(`UPDATE run_markets SET status = 'rodando', started_ms = $3 WHERE run_id = $1 AND market = $2`, [runId, marketId, startedMs]);

  const ctx = { regions: settings.regioes };
  while (i < mine.length) {
    if (Date.now() > deadline) return { finished: false };
    const product = mine[i];
    await q('UPDATE run_markets SET current = $3 WHERE run_id = $1 AND market = $2', [runId, marketId, product.name]);
    try {
      const result = await m.collect(product, ctx);
      offers += await saveMarketResult(runId, product, m.id, result, settings, now());
      log(`${m.name} · ${product.name}: ${result.offers.length} ofertas`);
    } catch (err) {
      errors.push(`${product.name}: ${err.message}`);
      log(`${m.name} · ${product.name}: ERRO ${err.message}`);
    }
    i++;
    await q('UPDATE run_markets SET done = $3, next_index = $3, offers = $4, error = $5 WHERE run_id = $1 AND market = $2', [
      runId, marketId, i, offers, errors.join(' | ') || null,
    ]);
  }

  const status = errors.length === 0 ? 'ok' : errors.length >= mine.length ? 'erro' : 'parcial';
  await q('UPDATE run_markets SET status = $3, ms = $4, current = NULL WHERE run_id = $1 AND market = $2', [
    runId, marketId, status, Date.now() - startedMs,
  ]);
  await maybeFinalizeRun(runId, run.started_at);
  return { finished: true };
}

// Só a última loja a terminar consegue "pegar" a finalização (UPDATE ... RETURNING é atômico).
async function maybeFinalizeRun(runId, startedAt) {
  const claimed = await one(
    `UPDATE runs SET status = 'finalizando' WHERE id = $1 AND status = 'running'
     AND NOT EXISTS (SELECT 1 FROM run_markets WHERE run_id = $1 AND status IN ('pendente', 'rodando'))
     RETURNING id`,
    [runId],
  );
  if (!claimed) return;
  const at = now();
  for (const p of await listProducts({ onlyActive: true })) await detectNewLow(runId, p, startedAt, at);
  await q(`UPDATE runs SET finished_at = $2, status = 'ok' WHERE id = $1`, [runId, at]);
  log(`Coleta #${runId} concluída`);
  try {
    const sent = await sendAlertEmail(loadSettings());
    if (sent) log(`E-mail enviado com ${sent} novidade(s)`);
  } catch (err) {
    log(`Falha ao enviar e-mail: ${err.message}`);
  }
}

// Progresso da coleta mais recente, no formato que o painel espera.
export async function getProgress() {
  const run = await one('SELECT * FROM runs ORDER BY id DESC LIMIT 1');
  const running = !!run && ['running', 'finalizando'].includes(run.status);
  if (!running) return { running: false, runId: run?.id ?? null, total: 0, done: 0, current: {}, log: [] };
  const rows = await q('SELECT * FROM run_markets WHERE run_id = $1', [run.id]);
  const name = (id) => MARKETS.find((m) => m.id === id)?.name ?? id;
  const current = Object.fromEntries(rows.filter((r) => r.current).map((r) => [r.market, r.current]));
  return {
    running: true,
    runId: run.id,
    startedAt: run.started_at,
    total: rows.reduce((n, r) => n + r.total, 0),
    done: rows.reduce((n, r) => n + r.done, 0),
    current,
    log: rows.filter((r) => r.current).map((r) => `${name(r.market)} · ${r.current}`),
  };
}

// Execução local: todas as lojas em paralelo, no mesmo processo.
export async function runCollection(trigger = 'agendado') {
  const r = await startRun(trigger);
  if (!r.started) return r;
  const done = Promise.all(MARKETS.map((m) => runMarketSlice(r.runId, m.id))).catch((err) => log(`Coleta falhou: ${err.message}`));
  return { ...r, done };
}
