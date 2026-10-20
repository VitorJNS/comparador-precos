// Registro dos mercados. A ordem aqui define a cor de cada mercado no painel
// (a cor acompanha o mercado, nunca a posição no ranking).

import { createVtexSource } from './vtex.js';
import { collectPaoDeAcucar } from './paodeacucar.js';
import { collectPagueMenos } from './paguemenos.js';
import { collectTenda } from './tenda.js';
import { createKabumSource } from './kabum.js';

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

// Covabra (rede de Campinas e região): VTEX com uma loja (seller "covabraNN") por área de entrega.
const covabra = createVtexSource({
  key: 'covabra',
  catalogBase: 'https://www.covabra.com.br',
  storefront: 'https://www.covabra.com.br',
  regional: true,
  storeLabel: (id) => `Covabra · loja ${String(id).replace(/^covabra/i, '')}`,
});

// Só o canal de supermercado (mercado.carrefour.com.br). O marketplace carrefour.com.br
// fica de fora de propósito: lá vendem lojas parceiras, não o mercado.

// Varejo (lojas de eletro). Só entra em produtos marcados com "também em varejo";
// vale só o que a própria loja vende, sem parceiros de marketplace. Preço nacional.
// brand: a loja só vende essa marca (a marca conta como presente nos títulos dela).
const retail = (key, base, name, brand = null) =>
  createVtexSource({ key, catalogBase: base, storefront: base, regional: false, ownSellerOnly: true, storeLabel: () => `${name} (site)`, brand });

// Americanas (VTEX): a busca não traz preço; simula o carrinho só para a própria Americanas e para a
// Magalu, que vende e entrega dentro da Americanas (o site da Magalu bloqueia acesso automatizado).
// Demais parceiros do marketplace ficam de fora. Preço nacional (CEP de Campinas).
const americanas = createVtexSource({
  key: 'americanas',
  catalogBase: 'https://www.americanas.com.br',
  storefront: 'https://www.americanas.com.br',
  regional: false,
  storeLabel: () => 'Americanas (site)',
  fixedSellers: { cep: '13010-001', sellers: { 1: 'Americanas (site)', magazineluiza: 'Magalu (vendido na Americanas)' } },
});

// kind: 'mercado' (padrão de todo produto) ou 'varejo' (só produtos com channels = 'todos').
export const MARKETS = [
  { id: 'paguemenos', name: 'Pague Menos', kind: 'mercado', site: 'superpaguemenos.com.br', collect: collectPagueMenos },
  { id: 'carrefour', name: 'Carrefour', kind: 'mercado', site: 'mercado.carrefour.com.br', collect: carrefourMercado },
  { id: 'atacadao', name: 'Atacadão', kind: 'mercado', site: 'atacadao.com.br', collect: atacadao },
  { id: 'paodeacucar', name: 'Pão de Açúcar', kind: 'mercado', site: 'paodeacucar.com', collect: collectPaoDeAcucar },
  { id: 'sams', name: "Sam's Club", kind: 'mercado', site: 'samsclub.com.br', collect: sams },
  { id: 'tenda', name: 'Tenda Atacado', kind: 'mercado', site: 'tendaatacado.com.br', collect: collectTenda },
  { id: 'covabra', name: 'Covabra', kind: 'mercado', site: 'covabra.com.br', collect: covabra },
  { id: 'brastemp', name: 'Brastemp', kind: 'varejo', site: 'brastemp.com.br', collect: retail('brastemp', 'https://www.brastemp.com.br', 'Brastemp', 'Brastemp') },
  { id: 'electrolux', name: 'Electrolux', kind: 'varejo', site: 'loja.electrolux.com.br', collect: retail('electrolux', 'https://loja.electrolux.com.br', 'Electrolux', 'Electrolux') },
  { id: 'fastshop', name: 'Fast Shop', kind: 'varejo', site: 'site.fastshop.com.br', collect: retail('fastshop', 'https://site.fastshop.com.br', 'Fast Shop') },
  { id: 'kabum', name: 'KaBuM!', kind: 'varejo', site: 'kabum.com.br', collect: createKabumSource('kabum') },
  { id: 'magalu', name: 'Magalu', kind: 'varejo', site: 'kabum.com.br (vendido pela Magalu)', collect: createKabumSource('magalu') },
  { id: 'samsung', name: 'Samsung', kind: 'varejo', site: 'shop.samsung.com/br', collect: retail('samsung', 'https://shop.samsung.com/br', 'Samsung', 'Samsung') },
  // Lojas próprias de marcas de eletro (VTEX, só o que a própria fabricante vende). Cada uma só tem
  // a própria marca: para produtos de outras marcas a busca simplesmente não acha nada.
  ...[
    ['consul', 'Consul', 'https://www.consul.com.br'],
    ['compracerta', 'Compra Certa', 'https://www.compracerta.com.br'], // loja da Whirlpool: Brastemp, Consul, KitchenAid
    ['kitchenaid', 'KitchenAid', 'https://www.kitchenaid.com.br'],
    ['oster', 'Oster', 'https://www.oster.com.br'],
    ['arno', 'Arno', 'https://www.arno.com.br'],
    ['philco', 'Philco', 'https://www.philco.com.br'],
    ['britania', 'Britânia', 'https://www.britania.com.br'],
    ['mondial', 'Mondial', 'https://www.mondial.com.br'],
    ['cadence', 'Cadence', 'https://www.cadence.com.br'],
    ['panasonic', 'Panasonic', 'https://loja.panasonic.com.br'],
    ['midea', 'Midea', 'https://www.midea.com.br'],
    ['polishop', 'Polishop', 'https://www.polishop.com.br'],
    ['elgin', 'Elgin', 'https://www.elgin.com.br'],
  ].map(([id, name, base]) => ({
    id, name, kind: 'varejo', site: new URL(base).host,
    // Compra Certa (várias marcas da Whirlpool) e Polishop (várias marcas) não são de marca única.
    collect: retail(id, base, name, ['compracerta', 'polishop'].includes(id) ? null : name),
  })),
  { id: 'americanas', name: 'Americanas', kind: 'varejo', site: 'americanas.com.br (Americanas e Magalu)', collect: americanas },
];

// Lojas pedidas que não dá para consultar.
export const UNSUPPORTED = [
  { id: 'assai', name: 'Assaí', reason: 'Não vende online; só publica encartes em imagem por loja.' },
  { id: 'sumerbol', name: 'Sumerbol', reason: 'Não tem loja online; só publica encartes em imagem.' },
  { id: 'amazon', name: 'Amazon', reason: 'Bloqueia acesso automatizado (página de verificação anti-robô).' },
  { id: 'magalu-site', name: 'Magazine Luiza (site)', reason: 'Bloqueia acesso automatizado (Akamai). As ofertas da Magalu vêm do KaBuM e da Americanas.' },
  { id: 'casasbahia', name: 'Casas Bahia, Ponto e Extra', reason: 'Bloqueiam acesso automatizado (HTTP 403).' },
  { id: 'terabyte', name: 'Terabyte', reason: 'Bloqueia acesso automatizado (desafio da Cloudflare).' },
  { id: 'pichau', name: 'Pichau', reason: 'Bloqueia acesso automatizado (desafio da Cloudflare).' },
  { id: 'lg', name: 'LG', reason: 'O site carrega os produtos por JavaScript, sem interface de busca aberta. Produtos LG vêm do varejo.' },
  { id: 'philips', name: 'Philips Walita', reason: 'O site não tem loja com busca aberta. Produtos Philips vêm do varejo.' },
];

export const marketsFor = (product) => MARKETS.filter((m) => m.kind === 'mercado' || product.channels === 'todos');

// Tela de cadastro: busca o texto em todas as lojas, em paralelo. Lojas que não respondem
// a tempo ficam de fora (a lista mostra o que chegou). Retorna { items, failed }.
export async function previewAll(text, ctx, { timeoutMs = 20000 } = {}) {
  const items = [];
  const failed = [];
  await Promise.all(
    MARKETS.filter((m) => m.collect.preview).map(async (m) => {
      let timer;
      try {
        const found = await Promise.race([
          m.collect.preview(text, ctx),
          new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('demorou demais')), timeoutMs))),
        ]);
        for (const it of found) items.push({ ...it, market: m.id, marketName: m.name, kind: m.kind });
      } catch {
        failed.push(m.name);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { items, failed };
}

// Ao cadastrar um produto: procura uma imagem nas lojas de busca rápida, em paralelo,
// e fica com a primeira que conferir com o produto (ou null se nenhuma achar a tempo).
export async function findProductImage(product, { timeoutMs = 12000 } = {}) {
  const tries = MARKETS.filter((m) => m.collect.findImage).map((m) =>
    m.collect.findImage(product).then((img) => img ?? Promise.reject(new Error('sem imagem'))),
  );
  const timeout = new Promise((r) => setTimeout(() => r(null), timeoutMs).unref?.());
  return Promise.race([Promise.any(tries).catch(() => null), timeout]);
}
