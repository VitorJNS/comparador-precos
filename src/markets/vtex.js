// Coletor genérico para lojas na plataforma VTEX (Atacadão, Sam's Club, Carrefour).
//
// 1. Busca no catálogo público:   /api/catalog_system/pub/products/search?ft=...
// 2. Descobre as lojas (sellers) que atendem cada CEP:   /api/checkout/pub/regions
// 3. Simula um carrinho por CEP para obter o preço real de cada loja:
//                                  /api/checkout/pub/orderForms/simulation
// Sites sem regionalização (regional: false) usam o preço que vem na própria busca.

import { getJson, postJson } from '../http.js';
import { chunks, evaluate, normalize, searchAll, searchTerms } from '../matcher.js';

const REGION_TTL_MS = 12 * 60 * 60 * 1000;

// Voltagem do SKU (campo de variação "Voltagem" do anúncio). Vale mais que o título: na Americanas,
// "…Branca 110V/220V" é o SKU 110V e "…Branca" (sem voltagem) é o 220V.
const VOLT_IN_TITLE = /\s*[-–(]?\s*\b(?:\d{3}\s*v(?:olts?)?(?:\s*\/\s*\d{3}\s*v(?:olts?)?)?|bivolt)\b\s*\)?/gi;
function skuVoltage(item) {
  for (const v of item.variations ?? []) {
    if (!/volt/i.test(v)) continue;
    const raw = String(item[v]?.[0] ?? '');
    if (/bivolt/i.test(raw)) return 'Bivolt';
    const n = raw.match(/\d{3}/)?.[0];
    if (n) return `${n}V`;
  }
  return null;
}

// Algumas lojas juntam o nome do produto e o da variação, que repete o começo
// ("Lava e Seca LG VC4 12kg CV5012WC4A Lava e Seca LG VC4 12kg CV5012WC4"): fica com o mais completo.
function dedupeName(s) {
  const words = String(s).split(/\s+/);
  const head = normalize(words.slice(0, 4).join(' ')).trim();
  if (words.length < 8 || !head) return s;
  for (let i = 4; i <= words.length - 4; i++) {
    const rest = words.slice(i).join(' ');
    if (normalize(rest).trim().startsWith(head)) {
      const first = words.slice(0, i).join(' ');
      return rest.length >= first.length ? rest : first;
    }
  }
  return s;
}

// Título do item, com a voltagem real do SKU no fim (quando a loja informa).
function itemTitle(p, item) {
  const base = dedupeName(item.nameComplete && item.nameComplete !== p.productName ? item.nameComplete : p.productName);
  const volt = skuVoltage(item);
  return volt ? `${base.replace(VOLT_IN_TITLE, ' ').replace(/\s{2,}/g, ' ').trim()} ${volt}` : base;
}

const SIM_CHUNK = 40;

// Preço à vista no Pix: o Radar mostra o Pix como preço principal (quem parcela vê o resto no site).
const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const pixNote = (card) => `Preço no Pix · ${brl(card)} no cartão`;

// Preço "de" só vale se for maior que o preço no cartão (algumas lojas repetem o preço do cartão como
// "de"; comparado com o Pix, o desconto do Pix pareceria promoção).
export const realListPrice = (list, card) => (list && card && list > card * 1.01 ? list : null);

// Parcela única "Pix" informada na busca, se for menor que o preço do cartão.
function searchPix(o) {
  const pix = (o.Installments ?? []).find((i) => /pix/i.test(i.PaymentSystemName ?? '') && i.NumberOfInstallments === 1)?.Value;
  return pix && o.Price && pix < o.Price - 0.005 ? pix : null;
}

// ownSellerOnly: aceita só o vendedor "1" (a própria loja), ignorando parceiros de marketplace.
// fixedSellers: { cep, sellers: { sellerId: rótulo } } para lojas em que a busca não traz preço
// (ex.: Americanas): simula o carrinho num CEP só, apenas para os vendedores listados. Preço nacional.
// brand: loja de uma marca só (Samsung, Consul, Oster…). Muitas não repetem a marca no título
// ("Lava e Seca Smart Digital Inverter WD13T"): para conferir os termos, a marca conta como presente.
export function createVtexSource({ key, catalogBase, checkoutBase = catalogBase, storefront, regional, storeLabel, ownSellerOnly = false, fixedSellers = null, brand = null }) {
  const withBrand = (title) => (brand && !normalize(title).includes(` ${normalize(brand).trim()} `) ? `${title} ${brand}` : title);
  let sellerCache = null; // { at, sellers: Map<sellerId, { name, regions:Set, cep }> }

  async function search(query) {
    // Aspas, parênteses e afins não ajudam a busca, e o filtro de segurança de algumas lojas
    // (ex.: Americanas) recusa a consulta inteira por causa deles ("Scripts are not allowed").
    const clean = String(query).replace(/[^\p{L}\p{N}\s.,\-/]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const url = `${catalogBase}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(clean)}&_from=0&_to=49`;
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
          const title = itemTitle(p, item);
          const image = item.images?.[0]?.imageUrl;
          if (image && evaluate(product, { title: withBrand(title), ean: item.ean || null, key: `${key}:${item.itemId}` }).match) return image;
        }
      }
    }
    return null;
  }

  // Preço e estoque de cada (item, vendedor) dos fixedSellers, num CEP. Retorna Map "item|vendedor" -> oferta.
  // perItem: um carrinho por item, para ler o preço no Pix dele (a opção Pix da simulação vale
  // para o carrinho inteiro). Usado na coleta; a tela de cadastro simula em lote (mais rápido).
  async function simulateFixed(skus, { perItem = false } = {}) {
    const items = skus.flatMap(({ id, sellers }) => sellers.filter((s) => s in fixedSellers.sellers).map((seller) => ({ id, quantity: 1, seller })));
    const out = new Map();
    const size = perItem ? 1 : SIM_CHUNK;
    for (let i = 0; i < items.length; i += size) {
      const { data } = await postJson(`${checkoutBase}/api/checkout/pub/orderForms/simulation?sc=1`, {
        items: items.slice(i, i + size),
        postalCode: fixedSellers.cep,
        country: 'BRA',
      });
      for (const it of data?.items ?? []) {
        const cents = it.sellingPrice ?? it.price;
        if (!cents) continue;
        // Preço "de" mais que 60% acima do atual é inflado por vendedores de marketplace: ignora
        // (senão vira alerta de promoção falso).
        const list = it.listPrice && it.listPrice > cents && it.listPrice <= cents * 1.6 ? it.listPrice / 100 : null;
        const pixCents = perItem
          ? data?.paymentData?.installmentOptions?.find((io) => /pix/i.test(io.paymentName ?? ''))?.installments?.find((x) => x.count === 1)?.value
          : null;
        out.set(`${it.id}|${it.seller}`, {
          price: cents / 100,
          pix: pixCents && pixCents < cents ? pixCents / 100 : null,
          listPrice: list,
          available: it.availability === 'available',
        });
      }
    }
    return out;
  }

  // Busca rápida para a tela de cadastro: só o catálogo, sem simular por CEP.
  // O preço é o da busca (aproximado nas lojas com preço por região).
  async function preview(text) {
    if (fixedSellers) return previewFixed(text);
    const out = [];
    for (const p of await search(text)) {
      for (const item of p.items ?? []) {
        const offers = (item.sellers ?? [])
          .filter((s) => !ownSellerOnly || s.sellerId === '1')
          .map((s) => s.commertialOffer ?? {})
          .filter((o) => o.Price || o.ListPrice);
        if (ownSellerOnly && !offers.length) continue; // só parceiros vendem: fora do varejo próprio
        const inStock = offers.filter((o) => o.AvailableQuantity > 0 && o.Price);
        const best = (inStock.length ? inStock : offers).sort((a, b) => (a.Price || a.ListPrice) - (b.Price || b.ListPrice))[0];
        out.push({
          title: itemTitle(p, item),
          url: `${storefront}/${p.linkText}/p`,
          image: item.images?.[0]?.imageUrl ?? null,
          ean: item.ean || null,
          extKey: `${key}:${item.itemId}`,
          brand,
          price: best ? searchPix(best) ?? (best.Price || best.ListPrice) : null,
          available: inStock.length > 0,
          approximate: regional,
        });
      }
    }
    return out;
  }

  // Tela de cadastro nas lojas com fixedSellers: simula os 20 itens mais parecidos com o texto
  // (a busca da Americanas costuma começar por peças de reposição).
  async function previewFixed(text) {
    const words = chunks(text);
    const items = [];
    for (const p of await search(text)) {
      for (const item of p.items ?? []) {
        const sellers = (item.sellers ?? []).map((s) => s.sellerId).filter((s) => s in fixedSellers.sellers);
        const title = normalize(itemTitle(p, item));
        if (sellers.length) items.push({ p, item, sellers, hits: words.filter((w) => title.includes(` ${w} `)).length });
      }
    }
    const top = items.sort((a, b) => b.hits - a.hits).slice(0, 20);
    const sim = await simulateFixed(top.map(({ item, sellers }) => ({ id: item.itemId, sellers })));
    return top.flatMap(({ p, item, sellers }) => {
      const offers = sellers.map((s) => sim.get(`${item.itemId}|${s}`)).filter(Boolean);
      if (!offers.length) return [];
      const inStock = offers.filter((o) => o.available);
      const best = (inStock.length ? inStock : offers).sort((a, b) => a.price - b.price)[0];
      return [{
        title: itemTitle(p, item),
        url: `${storefront}/${p.linkText}/p`,
        image: item.images?.[0]?.imageUrl ?? null,
        ean: item.ean || null,
        extKey: `${key}:${item.itemId}`,
          brand,
        price: best.price,
        available: inStock.length > 0,
      }];
    });
  }

  collect.findImage = findImage;
  collect.preview = preview;
  return collect;

  async function collect(product, ctx) {
    const all = await searchAll(product, search);
    const found = [...new Map(all.map((p) => [p.productId, p])).values()];
    const matched = new Map(); // skuId -> { title, url, image, ean, extKey, searchSellers }
    const candidates = [];

    for (const p of found) {
      for (const item of p.items ?? []) {
        const title = itemTitle(p, item);
        const extKey = `${key}:${item.itemId}`;
        const info = {
          title,
          url: `${storefront}/${p.linkText}/p`,
          image: item.images?.[0]?.imageUrl ?? null,
          ean: item.ean || null,
          extKey,
          searchSellers: item.sellers ?? [],
        };
        const verdict = evaluate(product, { title: withBrand(title), ean: info.ean, key: extKey });
        if (verdict.match) matched.set(item.itemId, info);
        else {
          const offer = info.searchSellers[0]?.commertialOffer;
          candidates.push({ ...info, price: offer?.Price || null, reason: verdict.reason });
        }
      }
    }

    const offers = [];
    if (!matched.size) return { offers, candidates };

    if (fixedSellers) {
      const skus = [...matched.entries()].map(([id, info]) => ({ id, sellers: info.searchSellers.map((s) => s.sellerId) }));
      const sim = await simulateFixed(skus, { perItem: true });
      for (const [id, info] of matched) {
        for (const s of info.searchSellers) {
          const o = sim.get(`${id}|${s.sellerId}`);
          if (!o) continue;
          offers.push({
            storeId: `${key}:${s.sellerId}:${info.extKey}`,
            storeName: fixedSellers.sellers[s.sellerId],
            regions: ['*'],
            title: info.title,
            url: info.url,
            image: info.image,
            extKey: info.extKey,
            ean: info.ean,
            price: o.pix ?? o.price,
            listPrice: realListPrice(o.listPrice, o.price),
            available: o.available,
            note: !o.available ? 'Sem estoque no site' : o.pix ? `${pixNote(o.price)} · vale para todo o Brasil` : 'Preço do site (vale para todo o Brasil)',
          });
        }
      }
      return { offers, candidates };
    }

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
            price: searchPix(o) ?? (o.Price || o.ListPrice),
            listPrice: realListPrice(o.ListPrice, o.Price),
            available: o.AvailableQuantity > 0 && !!o.Price,
            note: searchPix(o) ? `${pixNote(o.Price)} · vale para todo o Brasil` : 'Preço do site (vale para todo o Brasil)',
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
