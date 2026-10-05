// KaBuM (kabum.com.br): API pública de busca do catálogo.
//
// O KaBuM também é marketplace. Cada item informa quem vende:
//   - is_marketplace = false      -> vendido e entregue pelo próprio KaBuM
//   - marketplace.seller_name     -> loja parceira; "Magalu" é a própria Magazine Luiza
//     (mesmo grupo), que vende e entrega. O site da Magalu bloqueia acesso automatizado,
//     então as ofertas dela vêm daqui.
// Os demais parceiros ficam de fora. O preço é nacional (o mesmo para todo o Brasil).

import { getJson } from '../http.js';
import { evaluate, searchTerms } from '../matcher.js';

const API = 'https://servicespub.prod.api.aws.grupokabum.com.br/catalog/v2/search';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // termo -> { at, items } (as duas fontes fazem as mesmas buscas)

// A busca do KaBuM falha com frases longas ("nada encontrado"). Além dos termos do produto,
// tenta o código do modelo (ex.: obat641) e as duas primeiras palavras da busca.
function kabumTerms(product) {
  const terms = searchTerms(product);
  for (const t of product.include) {
    for (const alt of t.split('|')) {
      const a = alt.trim().toLowerCase();
      if (a.length >= 4 && /[a-z]/.test(a) && /\d/.test(a) && !/\s/.test(a)) terms.push(a);
    }
  }
  for (const qq of product.query.split(';')) {
    const words = qq.trim().split(/\s+/);
    if (words.length > 2) terms.push(words.slice(0, 2).join(' '));
  }
  return [...new Set(terms.map((t) => t.toLowerCase()))].slice(0, 6);
}

async function search(term) {
  const hit = cache.get(term);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  const url = `${API}?query=${encodeURIComponent(term)}&page_number=1&page_size=60&sort=most_searched`;
  const { status, data } = await getJson(url);
  // 404 CATALOG_NOT_MATCH = nenhum resultado (não é erro).
  if (status !== 200 && !data?.errors?.some((e) => e.code === 'CATALOG_NOT_MATCH')) {
    throw new Error(`KaBuM respondeu HTTP ${status}`);
  }
  const items = Array.isArray(data?.data) ? data.data : [];
  cache.set(term, { at: Date.now(), items });
  return items;
}

async function searchProduct(product) {
  const byId = new Map();
  for (const term of kabumTerms(product)) {
    for (const it of await search(term)) byId.set(it.id, it);
  }
  return [...byId.values()];
}

const SELLERS = {
  kabum: { label: 'KaBuM! (site)', owns: (a) => !a.is_marketplace },
  magalu: { label: 'Magalu (vendido no KaBuM!)', owns: (a) => a.is_marketplace && /^magalu$/i.test(a.marketplace?.seller_name ?? '') },
};

function toInfo(key, it) {
  const a = it.attributes;
  return {
    title: a.title,
    url: `https://www.kabum.com.br/produto/${it.id}/${a.product_link ?? ''}`,
    image: a.photos?.g?.[0] ?? a.images?.[0] ?? null,
    ean: null,
    extKey: `${key}:${it.id}`,
  };
}

/** key: 'kabum' (vendido pelo KaBuM) ou 'magalu' (vendido pela Magalu dentro do KaBuM). */
export function createKabumSource(key) {
  const seller = SELLERS[key];
  async function collect(product) {
    const offers = [];
    const candidates = [];
    for (const it of await searchProduct(product)) {
      const a = it.attributes;
      if (!seller.owns(a)) continue;
      const info = toInfo(key, it);
      const price = a.price || a.price_with_discount;
      const verdict = evaluate(product, { title: info.title, ean: null, key: info.extKey });
      if (!verdict.match) {
        candidates.push({ ...info, price: price || null, reason: verdict.reason });
        continue;
      }
      if (!price) continue;
      const pix = a.price_with_discount && a.price_with_discount < price ? a.price_with_discount : null;
      offers.push({
        storeId: `${key}:${it.id}`,
        storeName: seller.label,
        regions: ['*'],
        ...info,
        price,
        listPrice: a.old_price > price ? a.old_price : null,
        available: !!a.available && (a.stock ?? 1) > 0,
        note: pix ? `R$ ${pix.toFixed(2).replace('.', ',')} no PIX · preço do site` : 'Preço do site (vale para todo o Brasil)',
      });
    }
    return { offers, candidates };
  }
  // Primeira imagem de um item que confere com o produto (usada ao cadastrar).
  collect.findImage = async (product) => {
    for (const it of await searchProduct(product)) {
      const info = toInfo(key, it);
      if (info.image && evaluate(product, { title: info.title, ean: null, key: info.extKey }).match) return info.image;
    }
    return null;
  };
  return collect;
}
