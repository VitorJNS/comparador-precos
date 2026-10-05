// Coletor genérico para lojas na plataforma VTEX (Atacadão, Sam's Club, Carrefour).
//
// 1. Busca no catálogo público:   /api/catalog_system/pub/products/search?ft=...
// 2. Descobre as lojas (sellers) que atendem cada CEP:   /api/checkout/pub/regions
// 3. Simula um carrinho por CEP para obter o preço real de cada loja:
//                                  /api/checkout/pub/orderForms/simulation
// Sites sem regionalização (regional: false) usam o preço que vem na própria busca.

import { getJson, postJson } from '../http.js';
import { evaluate, searchAll, searchTerms } from '../matcher.js';

const REGION_TTL_MS = 12 * 60 * 60 * 1000;
const SIM_CHUNK = 40;

// ownSellerOnly: aceita só o vendedor "1" (a própria loja), ignorando parceiros de marketplace.
export function createVtexSource({ key, catalogBase, checkoutBase = catalogBase, storefront, regional, storeLabel, ownSellerOnly = false }) {
  let sellerCache = null; // { at, sellers: Map<sellerId, { name, regions:Set, cep }> }

  async function search(query) {
    const url = `${catalogBase}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(query)}&_from=0&_to=49`;
    const { data } = await getJson(url);
    return Array.isArray(data) ? data : [];
  }

  async function sellersByRegion(regions) {
    if (sellerCache && Date.now() - sellerCache.at < REGION_TTL_MS) return sellerCache.sellers;
    const sellers = new Map();
    for (const region of regions) {
      for (const { cep } of region.ceps) {
        const url = `${checkoutBase}/api/checkout/pub/regions?country=BRA&postalCode=${cep}&sc=1`;
        const { data } = await getJson(url).catch(() => ({ data: [] }));
        for (const s of data?.[0]?.sellers ?? []) {
          const entry = sellers.get(s.id) ?? { name: s.name, regions: new Set(), cep };
          entry.regions.add(region.id);
          sellers.set(s.id, entry);
        }
      }
    }
    sellerCache = { at: Date.now(), sellers };
    return sellers;
  }

  async function simulate(skus, sellers) {
    // Agrupa as lojas pelo CEP em que foram descobertas: uma simulação por CEP.
    const byCep = new Map();
    for (const [sellerId, s] of sellers) {
      if (!byCep.has(s.cep)) byCep.set(s.cep, []);
      byCep.get(s.cep).push(sellerId);
    }
    const results = [];
    for (const [cep, sellerIds] of byCep) {
      const items = skus.flatMap((sku) => sellerIds.map((seller) => ({ id: sku, quantity: 1, seller })));
      for (let i = 0; i < items.length; i += SIM_CHUNK) {
        const chunk = items.slice(i, i + SIM_CHUNK);
        const { data } = await postJson(`${checkoutBase}/api/checkout/pub/orderForms/simulation?sc=1`, {
          items: chunk,
          postalCode: cep,
          country: 'BRA',
        });
        for (const it of data?.items ?? []) results.push(it);
      }
    }
    return results;
  }

  // Primeira imagem de um item que confere com o produto (usada ao cadastrar; só a busca, sem preço).
  async function findImage(product) {
    for (const term of searchTerms(product)) {
      for (const p of await search(term)) {
        for (const item of p.items ?? []) {
          const title = item.nameComplete || p.productName;
          const image = item.images?.[0]?.imageUrl;
          if (image && evaluate(product, { title, ean: item.ean || null, key: `${key}:${item.itemId}` }).match) return image;
        }
      }
    }
    return null;
  }

  collect.findImage = findImage;
  return collect;

  async function collect(product, ctx) {
    const all = await searchAll(product, search);
    const found = [...new Map(all.map((p) => [p.productId, p])).values()];
    const matched = new Map(); // skuId -> { title, url, image, ean, extKey, searchSellers }
    const candidates = [];

    for (const p of found) {
      for (const item of p.items ?? []) {
        const title = item.nameComplete && item.nameComplete !== p.productName ? item.nameComplete : p.productName;
        const extKey = `${key}:${item.itemId}`;
        const info = {
          title,
          url: `${storefront}/${p.linkText}/p`,
          image: item.images?.[0]?.imageUrl ?? null,
          ean: item.ean || null,
          extKey,
          searchSellers: item.sellers ?? [],
        };
        const verdict = evaluate(product, { title, ean: info.ean, key: extKey });
        if (verdict.match) matched.set(item.itemId, info);
        else {
          const offer = info.searchSellers[0]?.commertialOffer;
          candidates.push({ ...info, price: offer?.Price || null, reason: verdict.reason });
        }
      }
    }

    const offers = [];
    if (!matched.size) return { offers, candidates };

    if (!regional) {
      for (const info of matched.values()) {
        for (const s of info.searchSellers) {
          if (ownSellerOnly && s.sellerId !== '1') continue;
          const o = s.commertialOffer ?? {};
          if (!o.Price && !o.ListPrice) continue;
          offers.push({
            storeId: `${key}:${s.sellerId}:${info.extKey}`,
            storeName: storeLabel(s.sellerId, s.sellerName),
            regions: ['*'],
            title: info.title,
            url: info.url,
            image: info.image,
            extKey: info.extKey,
            ean: info.ean,
            price: o.Price || o.ListPrice,
            listPrice: o.ListPrice || null,
            available: o.AvailableQuantity > 0 && !!o.Price,
            note: 'Preço do site (vale para todo o Brasil)',
          });
        }
      }
      return { offers, candidates };
    }

    const sellers = await sellersByRegion(ctx.regions);
    const sim = await simulate([...matched.keys()], sellers);
    const seen = new Set();
    for (const it of sim) {
      const info = matched.get(it.id);
      const cents = it.sellingPrice ?? it.price;
      if (!info || !cents) continue; // loja não trabalha com o item
      const storeKey = `${key}:${it.seller}:${it.id}`;
      if (seen.has(storeKey)) continue;
      seen.add(storeKey);
      const seller = sellers.get(it.seller);
      offers.push({
        storeId: storeKey,
        storeName: storeLabel(it.seller, seller?.name),
        regions: [...(seller?.regions ?? [])],
        title: info.title,
        url: info.url,
        image: info.image,
        extKey: info.extKey,
        ean: info.ean,
        price: cents / 100,
        listPrice: it.listPrice ? it.listPrice / 100 : null,
        available: it.availability === 'available',
        note:
          it.availability === 'available'
            ? null
            : it.availability === 'cannotBeDelivered'
              ? 'Loja não entrega no CEP pesquisado'
              : 'Sem estoque no site',
      });
    }
    return { offers, candidates };
  }
}
