// Super Pague Menos (superpaguemenos.com.br). A página de busca é renderizada
// no servidor; cada card de produto traz um data-json com preço e desconto.

import { getText } from '../http.js';
import { evaluate, searchAll } from '../matcher.js';

const BASE = 'https://www.superpaguemenos.com.br';

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

function parseCards(html) {
  const cards = [];
  for (const block of html.split(/<div\s+class="item-product\b[^"]*"/).slice(1)) {
    const json = block.match(/data-json='([^']*)'/)?.[1];
    if (!json) continue;
    let data;
    try {
      data = JSON.parse(decode(json));
    } catch {
      continue;
    }
    const href = block.match(/href="([^"]+\/p)"/)?.[1];
    const img = block.match(/data-src="([^"]+)"/)?.[1];
    const list = Number(data.price) || null;
    const discount = Number(data.discount) || 0;
    cards.push({
      id: String(data.item_id),
      title: decode(String(data.item_name ?? '')),
      url: href ? new URL(href, BASE).href : null,
      image: img ? (img.startsWith('//') ? `https:${img}` : img) : null,
      price: list ? Math.round((list - discount) * 100) / 100 : null,
      listPrice: discount > 0 ? list : null,
      available: !/avise-me|indispon[ií]vel|esgotado/i.test(block),
    });
  }
  return cards;
}

async function search(q) {
  const { text } = await getText(`${BASE}/busca/?q=${encodeURIComponent(q)}`);
  return parseCards(text);
}

export async function collectPagueMenos(product) {
  const cards = await searchAll(product, search);

  const offers = [];
  const candidates = [];
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c.id) || !c.price) continue;
    seen.add(c.id);
    const extKey = `paguemenos:${c.id}`;
    const verdict = evaluate(product, { title: c.title, key: extKey });
    const info = { title: c.title, url: c.url, image: c.image, ean: null, extKey };
    if (!verdict.match) {
      candidates.push({ ...info, price: c.price, reason: verdict.reason });
      continue;
    }
    offers.push({
      ...info,
      storeId: `paguemenos:site:${c.id}`,
      storeName: 'Pague Menos (site)',
      regions: ['*'],
      price: c.price,
      listPrice: c.listPrice,
      available: c.available,
      note: c.available ? 'Preço do site' : 'Indisponível no site',
    });
  }
  return { offers, candidates };
}
