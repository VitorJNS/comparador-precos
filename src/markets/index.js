// Registro dos mercados. A ordem aqui define a cor de cada mercado no painel
// (a cor acompanha o mercado, nunca a posição no ranking).

import { createVtexSource } from './vtex.js';
import { collectPaoDeAcucar } from './paodeacucar.js';
import { collectPagueMenos } from './paguemenos.js';
import { collectTenda } from './tenda.js';

const atacadao = createVtexSource({
  key: 'atacadao',
  catalogBase: 'https://www.atacadao.com.br/io',
  checkoutBase: 'https://www.atacadao.com.br',
  storefront: 'https://www.atacadao.com.br',
  regional: true,
  storeLabel: (id, name) => `Atacadão ${name ?? id}`,
});

const sams = createVtexSource({
  key: 'sams',
  catalogBase: 'https://www.samsclub.com.br',
  storefront: 'https://www.samsclub.com.br',
  regional: true,
  storeLabel: (id, name) => (id === 'samsclub6058' ? "Sam's Club (entrega do site)" : (name ?? id)),
});

const carrefourMercado = createVtexSource({
  key: 'carrefour-mercado',
  catalogBase: 'https://carrefourbrfood.vtexcommercestable.com.br',
  storefront: 'https://mercado.carrefour.com.br',
  regional: true,
  storeLabel: (id) => `Carrefour Mercado · loja ${id.replace(/^carrefourbr/, '')}`,
});

// Só o canal de supermercado (mercado.carrefour.com.br). O marketplace carrefour.com.br
// fica de fora de propósito: lá vendem lojas parceiras, não o mercado.

// Varejo (lojas de eletro). Só entra em produtos marcados com "também em varejo";
// vale só o que a própria loja vende, sem parceiros de marketplace. Preço nacional.
const retail = (key, base, name) =>
  createVtexSource({ key, catalogBase: base, storefront: base, regional: false, ownSellerOnly: true, storeLabel: () => `${name} (site)` });

// kind: 'mercado' (padrão de todo produto) ou 'varejo' (só produtos com channels = 'todos').
export const MARKETS = [
  { id: 'paguemenos', name: 'Pague Menos', kind: 'mercado', site: 'superpaguemenos.com.br', collect: collectPagueMenos },
  { id: 'carrefour', name: 'Carrefour', kind: 'mercado', site: 'mercado.carrefour.com.br', collect: carrefourMercado },
  { id: 'atacadao', name: 'Atacadão', kind: 'mercado', site: 'atacadao.com.br', collect: atacadao },
  { id: 'paodeacucar', name: 'Pão de Açúcar', kind: 'mercado', site: 'paodeacucar.com', collect: collectPaoDeAcucar },
  { id: 'sams', name: "Sam's Club", kind: 'mercado', site: 'samsclub.com.br', collect: sams },
  { id: 'tenda', name: 'Tenda Atacado', kind: 'mercado', site: 'tendaatacado.com.br', collect: collectTenda },
  { id: 'brastemp', name: 'Brastemp', kind: 'varejo', site: 'brastemp.com.br', collect: retail('brastemp', 'https://www.brastemp.com.br', 'Brastemp') },
  { id: 'electrolux', name: 'Electrolux', kind: 'varejo', site: 'loja.electrolux.com.br', collect: retail('electrolux', 'https://loja.electrolux.com.br', 'Electrolux') },
  { id: 'fastshop', name: 'Fast Shop', kind: 'varejo', site: 'site.fastshop.com.br', collect: retail('fastshop', 'https://site.fastshop.com.br', 'Fast Shop') },
];

// Lojas pedidas que não dá para consultar.
export const UNSUPPORTED = [
  { id: 'assai', name: 'Assaí', reason: 'Não vende online; só publica encartes em imagem por loja.' },
  { id: 'sumerbol', name: 'Sumerbol', reason: 'Não tem loja online; só publica encartes em imagem.' },
  { id: 'magalu', name: 'Magalu', reason: 'Bloqueia qualquer acesso automatizado ao site (proteção Akamai).' },
];

export const marketsFor = (product) => MARKETS.filter((m) => m.kind === 'mercado' || product.channels === 'todos');
