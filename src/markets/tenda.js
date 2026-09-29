// Tenda Atacado (Next.js). Os produtos da busca vêm no __NEXT_DATA__ da página.

import { getText } from '../http.js';
import { evaluate, searchAll } from '../matcher.js';

const BASE = 'https://www.tendaatacado.com.br';
const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function search(q) {
  const { text } = await getText(`${BASE}/busca?q=${encodeURIComponent(q)}`);
  const raw = text.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
  if (!raw) throw new Error('Estrutura da página do Tenda mudou (__NEXT_DATA__ ausente)');
  const data = JSON.parse(raw);
  return data?.props?.initialMobxState?.productStore?.products ?? [];
}

export async function collectTenda(product) {
  const all = await searchAll(product, search);
  const items = [...new Map(all.map((p) => [p.id, p])).values()];

  const offers = [];
  const candidates = [];
  for (const p of items) {
    if (p.seller && p.seller.id !== 1) continue; // só o próprio Tenda, sem vendedores parceiros
    const extKey = `tenda:${p.id}`;
    const info = { title: p.name, url: p.url, image: p.thumbnail ?? null, ean: null, extKey };
    const verdict = evaluate(product, { title: p.name, key: extKey });
    if (!verdict.match) {
      candidates.push({ ...info, price: p.price, reason: verdict.reason });
      continue;
    }
    const promoPrice = p.promotion?.price && p.promotion.price < p.price ? p.promotion.price : null;
    const wholesale = (p.wholesalePrices ?? []).filter((w) => w.price < (promoPrice ?? p.price));
    const notes = [];
    if (p.promotion?.endDate && promoPrice) notes.push(`Promoção até ${p.promotion.endDate.slice(0, 10).split('-').reverse().join('/')}`);
    if (wholesale.length) notes.push(`${brl(wholesale[0].price)} a partir de ${wholesale[0].minQuantity} un.`);
    const available = p.isAvailable !== false && p.availability !== 'out_of_stock';
    offers.push({
      ...info,
      storeId: `tenda:site:${p.id}`,
      storeName: 'Tenda Atacado (site)',
      regions: ['*'],
      price: promoPrice ?? p.price,
      listPrice: promoPrice ? p.price : null,
      available,
      note: available ? notes.join(' · ') || 'Preço do site' : 'Sem estoque no site',
    });
  }
  return { offers, candidates };
}
