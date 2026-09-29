// Pão de Açúcar (GPA). Cada loja tem seu próprio preço: descobrimos as lojas
// que entregam em cada CEP e buscamos o produto em cada uma delas.

import { getJson, postJson } from '../http.js';
import { evaluate, searchTerms } from '../matcher.js';

const API = 'https://api.vendas.gpa.digital/pa';
const IMG = 'https://static.paodeacucar.com';
const HEADERS = { Accept: 'application/json, text/plain, */*', Origin: 'https://www.paodeacucar.com' };
const STORE_TTL_MS = 12 * 60 * 60 * 1000;
let storeCache = null;

async function storesByRegion(regions) {
  if (storeCache && Date.now() - storeCache.at < STORE_TTL_MS) return storeCache.stores;
  const stores = new Map(); // storeId -> { name, regions:Set }
  for (const region of regions) {
    for (const { cep } of region.ceps) {
      const { data } = await getJson(`${API}/delivery/ecom/${cep}?isNal=false`, { headers: HEADERS }).catch(() => ({ data: null }));
      for (const t of data?.content?.deliveryTypes ?? []) {
        const id = t.storeid ?? t.storeId;
        if (!id) continue;
        const entry = stores.get(id) ?? { name: t.storeName ?? `Loja ${id}`, regions: new Set() };
        entry.regions.add(region.id);
        stores.set(id, entry);
      }
    }
  }
  storeCache = { at: Date.now(), stores };
  return stores;
}

async function search(terms, storeId) {
  const { data } = await postJson(
    `${API}/search/search`,
    {
      terms,
      page: 1,
      sortBy: 'relevance',
      resultsPerPage: 30,
      allowRedirect: true,
      storeId,
      department: 'ecom',
      customerPlus: true,
      partner: 'linx',
    },
    { headers: HEADERS },
  );
  return data?.products ?? [];
}

export async function collectPaoDeAcucar(product, ctx) {
  const stores = await storesByRegion(ctx.regions);
  const offers = [];
  const candidates = new Map();
  // Testamos todos os termos até uma loja responder; daí em diante, só os que trouxeram resultado.
  // Se as 3 primeiras lojas não têm nenhum item que bata com o produto, a rede não vende
  // o item e as demais não são consultadas (a busca sempre devolve "algo", ex.: saco de
  // freezer para "geladeira", então só resultado não basta).
  let terms = searchTerms(product);
  let probed = false;
  let visited = 0;

  for (const [storeId, store] of stores) {
    if (++visited > 3 && !offers.length) break;
    const results = [];
    const useful = [];
    for (const t of terms) {
      const r = await search(t, storeId);
      if (r.length) useful.push(t);
      results.push(...r);
    }
    if (!probed && useful.length) {
      probed = true;
      terms = useful;
    }
    const seenHere = new Set();
    for (const p of results) {
      if (seenHere.has(p.id)) continue;
      seenHere.add(p.id);
      // Só o que a própria rede vende; itens de lojas parceiras (marketplace) ficam de fora.
      if (p.sellType && p.sellType !== '1P') continue;
      const extKey = `paodeacucar:${p.id}`;
      const info = {
        title: p.name,
        url: p.urlDetails,
        image: p.productImages?.[0] ? `${IMG}${p.productImages[0]}` : null,
        ean: null,
        extKey,
      };
      const verdict = evaluate(product, { title: p.name, key: extKey });
      if (!verdict.match) {
        candidates.set(extKey, { ...info, price: p.price, reason: verdict.reason });
        continue;
      }
      const promo = p.productPromotion;
      let note = null;
      if (promo?.promotionQuantityBuy && promo?.promotionQuantityPayFor) {
        note = `Leve ${promo.promotionQuantityBuy}, pague ${promo.promotionQuantityPayFor}`;
      } else if (promo?.appExclusive) {
        note = 'Preço exclusivo do app';
      }
      offers.push({
        ...info,
        storeId: `paodeacucar:${storeId}:${p.id}`,
        storeName: `Pão de Açúcar ${store.name.replace(/^\d+\s*-\s*/, '')}`,
        regions: [...store.regions],
        price: p.price,
        listPrice: p.priceFrom && p.priceFrom > p.price ? p.priceFrom : null,
        available: !!p.stock,
        note: p.stock ? note : 'Sem estoque na loja',
      });
    }
  }
  return { offers, candidates: [...candidates.values()] };
}
