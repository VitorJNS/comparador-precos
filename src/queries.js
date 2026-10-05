// Consultas de leitura usadas pelo painel e pelo e-mail.

import { q, one } from './db.js';
import { MARKETS } from './markets/index.js';
import { evaluate } from './matcher.js';

const marketName = Object.fromEntries(MARKETS.map((m) => [m.id, m.name]));
export const nameOfMarket = (id) => marketName[id] ?? id;

// Só ofertas disponíveis: itens sem estoque ficam guardados (para o alerta de
// "voltou ao estoque"), mas nunca aparecem em rankings, cards ou e-mails.
// Lojas de varejo só contam para produtos marcados com "também em varejo".
const MERCADO_IDS = MARKETS.filter((m) => m.kind === 'mercado').map((m) => `'${m.id}'`).join(',');

const withRegion = (rows, region) =>
  rows
    .map((r) => ({ ...r, regions: JSON.parse(r.regions), available: !!r.available }))
    .filter((r) => region === 'todas' || r.regions.includes('*') || r.regions.includes(region));

export async function getOffers(productId, region = 'todas') {
  const rows = await q(
    `SELECT o.* FROM offers o JOIN products p ON p.id = o.product_id
     WHERE o.product_id = $1 AND o.available = 1 AND (p.channels = 'todos' OR o.market IN (${MERCADO_IDS}))`,
    [productId],
  );
  return withRegion(rows, region);
}

// Mesma regra, para vários produtos de uma vez (a tela inicial faz uma consulta só).
export async function getOffersByProduct(region = 'todas') {
  const rows = await q(
    `SELECT o.* FROM offers o JOIN products p ON p.id = o.product_id
     WHERE o.available = 1 AND (p.channels = 'todos' OR o.market IN (${MERCADO_IDS}))`,
  );
  const map = new Map();
  for (const r of withRegion(rows, region)) {
    if (!map.has(r.product_id)) map.set(r.product_id, []);
    map.get(r.product_id).push(r);
  }
  return map;
}

// Voltagem no nome do anúncio. 110V e 127V são a mesma rede elétrica.
const VOLT_RE = /\s*[-–(]?\s*\b(?:(127|110|220)\s*v(?:olts)?|bivolt)\b\s*\)?/gi;
function voltageOf(title) {
  const m = title.match(/\b(127|110|220)\s*v(?:olts)?\b|\bbivolt\b/i);
  if (!m) return null;
  if (/bivolt/i.test(m[0])) return 'Bivolt';
  return m[1] === '220' ? '220V' : '127V';
}
const baseTitle = (title) => title.replace(VOLT_RE, ' ').replace(/[\s\-–,]+$/, '').replace(/\s{2,}/g, ' ').trim();
const titleKey = (title) =>
  baseTitle(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Agrupa lojas do mesmo mercado com o mesmo preço ("R$ 799,90 em 6 lojas").
// O mesmo aparelho em voltagens diferentes (códigos distintos no site) vira uma linha só,
// e cada loja conta uma vez, mesmo vendendo as duas voltagens.
export function rankOffers(offers) {
  const groups = new Map();
  for (const o of offers) {
    const key = `${o.market}|${o.price}|${o.list_price}|${o.available}|${titleKey(o.title)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        market: o.market,
        marketName: nameOfMarket(o.market),
        title: baseTitle(o.title),
        voltages: [],
        extKeys: [],
        image: o.image,
        url: o.url,
        price: o.price,
        listPrice: o.list_price,
        available: o.available,
        promo: !!(o.list_price && o.list_price > o.price * 1.01),
        discountPct: o.list_price && o.list_price > o.price ? Math.round((1 - o.price / o.list_price) * 100) : 0,
        seenAt: o.seen_at,
        changedAt: o.changed_at,
        stores: [],
      });
    }
    const g = groups.get(key);
    const volt = voltageOf(o.title);
    if (volt && !g.voltages.includes(volt)) g.voltages.push(volt);
    if (o.ext_key && !g.extKeys.includes(o.ext_key)) g.extKeys.push(o.ext_key);
    if (!g.stores.some((s) => s.name === o.store_name)) {
      g.stores.push({ id: o.store_id, extKey: o.ext_key, name: o.store_name, regions: o.regions, note: o.note, url: o.url });
    }
    if (o.seen_at > g.seenAt) g.seenAt = o.seen_at;
  }
  for (const g of groups.values()) g.voltages.sort();
  return [...groups.values()].sort((a, b) => b.available - a.available || a.price - b.price);
}

// Menor preço disponível por mercado, a cada coleta (para o gráfico de histórico).
// regionOf: store_id -> regiões (das ofertas atuais), para filtrar por região.
export function buildHistory(rows, regionOf, region = 'todas') {
  const byRun = new Map();
  for (const r of rows) {
    const regs = regionOf.get(r.store_id) ?? ['*'];
    if (region !== 'todas' && !regs.includes('*') && !regs.includes(region)) continue;
    if (!byRun.has(r.run_id)) byRun.set(r.run_id, { at: r.collected_at, prices: {} });
    const point = byRun.get(r.run_id);
    if (r.collected_at < point.at) point.at = r.collected_at;
    if (point.prices[r.market] == null || r.price < point.prices[r.market]) point.prices[r.market] = r.price;
  }
  return [...byRun.values()].sort((a, b) => (a.at < b.at ? -1 : 1));
}

// Menor preço de cada produto a cada coleta (gráfico pequeno dos cards), agregado no banco.
export async function sparkSeries(region = 'todas', days = 60) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const params = [since];
  let regionFilter = '';
  if (region !== 'todas') {
    params.push(`%"${region}"%`);
    regionFilter = `AND (f.regions LIKE $2 OR f.regions LIKE '%"*"%')`;
  }
  const rows = await q(
    `SELECT o.product_id, o.run_id, MIN(o.collected_at) AS at, MIN(o.price) AS min
     FROM observations o JOIN offers f ON f.product_id = o.product_id AND f.store_id = o.store_id
     WHERE o.available = 1 AND o.collected_at >= $1 ${regionFilter}
     GROUP BY o.product_id, o.run_id ORDER BY at`,
    params,
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.product_id)) map.set(r.product_id, []);
    map.get(r.product_id).push({ at: r.at, min: r.min });
  }
  return map;
}

export async function history(productId, region = 'todas', days = 90) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [offers, rows] = await Promise.all([
    q('SELECT store_id, regions FROM offers WHERE product_id = $1', [productId]),
    q(
      `SELECT run_id, market, store_id, price, collected_at FROM observations
       WHERE product_id = $1 AND available = 1 AND collected_at >= $2 ORDER BY run_id`,
      [productId, since],
    ),
  ]);
  const regionOf = new Map(offers.map((o) => [o.store_id, JSON.parse(o.regions)]));
  return buildHistory(rows, regionOf, region);
}

// Apaga ofertas guardadas que não batem mais com o filtro atual do produto,
// junto com o histórico e os alertas delas (senão o "menor preço já registrado"
// continuaria mostrando um item que não é o produto). Chamado ao editar ou descartar.
export async function purgeNonMatching(product) {
  const offers = await q('SELECT store_id, title, ean, ext_key FROM offers WHERE product_id = $1', [product.id]);
  const bad = offers.filter((o) => !evaluate(product, { title: o.title, ean: o.ean, key: o.ext_key }).match);
  if (bad.length) {
    const ids = bad.map((o) => o.store_id);
    for (const table of ['offers', 'observations', 'events']) {
      await q(`DELETE FROM ${table} WHERE product_id = $1 AND store_id = ANY($2)`, [product.id, ids]);
    }
  }
  return bad.map((o) => o.title);
}

// Foto do produto: prefere a de uma oferta disponível, mas usa a de uma oferta
// sem estoque quando não há outra (o card não fica sem imagem).
export async function productImages() {
  // Imagem da melhor oferta; sem ofertas, a imagem buscada quando o produto foi cadastrado.
  const rows = await q(
    `SELECT p.id AS product_id, COALESCE(
       (SELECT o.image FROM offers o WHERE o.product_id = p.id AND o.image IS NOT NULL AND o.image <> ''
        ORDER BY o.available DESC, o.price ASC LIMIT 1),
       p.image) AS image
     FROM products p`,
  );
  return new Map(rows.filter((r) => r.image).map((r) => [r.product_id, r.image]));
}

export async function productImage(productId) {
  return (await productImages()).get(productId) ?? null;
}

export async function historicMins() {
  const rows = await q('SELECT product_id, MIN(price) AS min FROM observations WHERE available = 1 GROUP BY product_id');
  return new Map(rows.map((r) => [r.product_id, r.min]));
}

export async function historicMin(productId) {
  return (await one('SELECT MIN(price) AS min FROM observations WHERE product_id = $1 AND available = 1', [productId]))?.min ?? null;
}

export async function recentEvents(limit = 50, productId = null) {
  const rows = productId
    ? await q(
        'SELECT e.*, p.name AS product_name FROM events e JOIN products p ON p.id = e.product_id WHERE e.product_id = $1 ORDER BY e.id DESC LIMIT $2',
        [productId, limit],
      )
    : await q('SELECT e.*, p.name AS product_name FROM events e JOIN products p ON p.id = e.product_id ORDER BY e.id DESC LIMIT $1', [limit]);
  return rows.map((e) => ({ ...e, marketName: nameOfMarket(e.market) }));
}
