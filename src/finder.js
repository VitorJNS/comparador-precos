// Cadastro simplificado: a pessoa procura em palavras dela, escolhe o produto pela foto
// e o app monta sozinho as regras de busca (termos, código do modelo, EAN, canais).

import { chunks, evaluate, hasTerm, normalize, wordAt } from './matcher.js';
import { baseTitle, titleKey } from './queries.js';
import { guessCategory } from './categories.js';

const SIZE = /^\d+ [a-z]+$/; // "13 kg", "500 ml" (já juntos por chunks)
const MAX_GROUPS = 30; // exatos (têm todas as palavras)
const MAX_SIMILAR = 15; // parecidos (falta uma palavra)

// Palavras que, antes da palavra buscada, indicam que o produto é outra coisa feita PARA ela:
// "Pipoca para Microondas", "Capa de Celular", "Suporte p/ TV".
const MODIFIERS = new Set(['para', 'p', 'pra', 'de', 'do', 'da', 'com']);
// Versões de brinquedo ou miniatura vão para o fim (a não ser que a pessoa tenha pedido).
const TOY = ['brinquedo', 'miniatura'];
// Peças e acessórios: quando o título COMEÇA com uma destas, é peça de reposição do produto
// ("Puxador Air Fryer Mondial", "Jarra de Liquidificador", "Placa Potência Geladeira").
const PARTS = new Set([
  'puxador', 'peca', 'pecas', 'refil', 'jarra', 'tampa', 'suporte', 'filtro', 'borracha', 'gaxeta', 'vedacao', 'guarnicao',
  'motor', 'motoventilador', 'placa', 'termostato', 'nivelador', 'pe', 'emblema', 'botao', 'cuba', 'cesto', 'grelha',
  'resistencia', 'mangueira', 'valvula', 'dobradica', 'prateleira', 'gaveta', 'cabo', 'adaptador', 'capa', 'pelicula',
  'acessorio', 'acessorios', 'membrana', 'anel', 'prato', 'lampada', 'sensor', 'rolamento', 'amortecedor', 'trava',
  'retentor', 'correia', 'bomba', 'tripe', 'eixo', 'helice', 'faca', 'lamina', 'copo', 'batedor', 'engrenagem',
]);

/**
 * Relevância do título para o texto da pessoa.
 *   hits: palavras do texto presentes (junta ou separada vale igual: microondas = micro-ondas);
 *   score: +10 por palavra; a 1ª palavra buscada como 1ª do título vale +8 (é o tipo do produto:
 *          "Geladeira Electrolux…"), como 2ª vale +3 ("Smart TV…"); depois disso é peça ou alimento
 *          ("Placa Potência Geladeira", "Lasanha Airfryer");
 *          -12 se ela vem depois de "para/de/com…" (acessório ou alimento "para" aquilo).
 *   missing: palavras do texto que o título não tem.
 * brand: loja de marca única; a marca conta como presente mesmo se o título não a repete.
 */
function relevance(words, text, title, brand = null) {
  const t = normalize(title);
  const tokens = t.trim().split(' ');
  const query = normalize(text);
  const withBrand = brand ? `${t}${normalize(brand).trim()} ` : t;
  let hits = 0;
  let score = 0;
  const missing = [];
  words.forEach((w, idx) => {
    const pos = wordAt(t, w);
    if (pos < 0) {
      if (wordAt(withBrand, w) >= 0) {
        hits++;
        score += 10;
      } else missing.push(w);
      return;
    }
    hits++;
    score += 10;
    const prev = tokens[pos - 1];
    // "pão de queijo": o "de" faz parte do que a pessoa digitou, não é modificador.
    if (MODIFIERS.has(prev) && !query.includes(` ${prev} ${w.split(' ')[0]}`)) score -= 12;
    else if (idx === 0) score += pos === 0 ? 8 : pos === 1 ? 3 : 0;
  });
  for (const w of TOY) if (t.includes(` ${w} `) && !query.includes(` ${w} `)) score -= 15;
  // Começa com nome de peça que a pessoa não digitou: vai para o fim.
  if (tokens.slice(0, 2).some((w) => PARTS.has(w) && !query.includes(` ${w} `))) score -= 20;
  return { hits, score, missing };
}

// Palavra legível para "não tem: …" (a medida volta a ficar junta: "13 kg" -> "13kg").
const label = (w) => w.replace(/^(d+) ([a-z]+)$/, '$1$2');

/**
 * Junta os resultados das lojas em grupos (mesmo produto em várias lojas) para a tela de escolha.
 * Mesmo EAN ou mesmo título = mesmo grupo.
 * Só entram itens com todas as palavras do texto (missing = []) ou, como "parecidos", com uma a menos
 * (missing = ["samsung"]). Ordem: exatos antes, depois relevância, estoque e preço.
 */
export function groupResults(text, items) {
  const words = chunks(text);
  const allowMissing = words.length >= 2 ? 1 : 0;
  const groups = new Map();
  const keyOf = new Map(); // "ean:..." ou "t:..." -> grupo (o mesmo produto pode ter vários EANs, ex.: 127V e 220V)
  for (const it of items) {
    if (!it.title) continue;
    const { hits, score, missing } = relevance(words, text, it.title, it.brand);
    if (missing.length > allowMissing) continue;
    const ids = [`t:${titleKey(it.title)}`, ...(it.ean ? [`ean:${it.ean}`] : [])];
    const key = ids.map((k) => keyOf.get(k)).find(Boolean) ?? ids[0];
    for (const k of ids) keyOf.set(k, key);
    if (!groups.has(key)) groups.set(key, { key, title: baseTitle(it.title), image: null, hits, score, missing, items: [] });
    const g = groups.get(key);
    g.hits = Math.max(g.hits, hits);
    g.score = Math.max(g.score, score);
    if (missing.length < g.missing.length) g.missing = missing;
    g.image ??= it.image;
    g.items.push(it);
  }
  const out = [...groups.values()].map((g) => {
    const inStock = g.items.filter((i) => i.available && i.price);
    const priced = (inStock.length ? inStock : g.items).filter((i) => i.price).sort((a, b) => a.price - b.price);
    const markets = [...new Map(g.items.map((i) => [i.market, i.marketName])).values()];
    return {
      key: g.key,
      title: g.title,
      image: g.image,
      hits: g.hits,
      score: g.score,
      missing: g.missing.map(label),
      available: inStock.length > 0,
      price: priced[0]?.price ?? null,
      approximate: priced[0]?.approximate ?? false,
      markets,
      // O que o cadastro precisa de cada item escolhido.
      items: g.items.map((i) => ({ market: i.market, kind: i.kind, extKey: i.extKey, ean: i.ean, title: i.title, image: i.image })),
    };
  });
  // Exatos primeiro; depois mais relevante; o preço só desempata entre itens igualmente relevantes.
  out.sort((a, b) => a.missing.length - b.missing.length || b.score - a.score || b.available - a.available || (a.price ?? Infinity) - (b.price ?? Infinity));
  const exact = out.filter((g) => !g.missing.length).slice(0, MAX_GROUPS);
  const similar = out.filter((g) => g.missing.length).slice(0, MAX_SIMILAR);
  return [...exact, ...similar];
}

// Códigos de modelo no título: letras e números juntos (WD13FG, BRO85AK, OBAT641, 60UA85),
// sem contar medidas como 13kg, 500ml ou 220V.
function modelCodes(title) {
  return String(title)
    .split(/[\s\-/(),.+]+/)
    .filter((t) => t.length >= 4 && /[a-z]/i.test(t) && /\d/.test(t) && !/^\d+[a-z]+$/i.test(t))
    .map((t) => t.toLowerCase());
}

// Código comum a todos os títulos escolhidos; senão o maior começo comum (ex.: wd13fg e wd13fg6b34 -> wd13fg).
function commonModelCode(titles) {
  const lists = titles.map(modelCodes);
  if (!lists.length || lists.some((l) => !l.length)) return null;
  const exact = lists[0].find((c) => lists.every((l) => l.includes(c)));
  if (exact) return exact;
  for (const code of lists[0]) {
    for (let n = code.length; n >= 4; n--) {
      const prefix = code.slice(0, n);
      if (/\d/.test(prefix) && /[a-z]/.test(prefix) && lists.every((l) => l.some((c) => c.startsWith(prefix)))) return prefix;
    }
  }
  return null;
}

const parseBRL = (v) => {
  const s = String(v ?? '').replace(/[^\d.,]/g, '');
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}\b)/g, ''));
  return n > 0 ? n : null;
};

/**
 * Monta o produto a partir do texto e dos itens escolhidos (pode ser nenhum:
 * "acompanhar mesmo assim"). others: títulos que apareceram na busca e não foram escolhidos
 * (servem para achar a palavra que diferencia, ex.: o sabor "maçã" entre vários detergentes).
 */
export function buildProduct(text, chosen = [], { maxPrice = null, others = [] } = {}) {
  const query = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!query) throw new Error('Escreva o que você quer acompanhar');
  const titles = chosen.map((c) => c.title);
  const inAll = (chunk) => titles.every((t) => normalize(t).includes(` ${chunk} `));

  let include;
  let code = null;
  if (titles.length) {
    code = commonModelCode(titles);
    // Medidas que todos os escolhidos têm (13 kg, 500 ml) + palavras do texto que estão em todos.
    const sizes = chunks(titles[0]).filter((c) => SIZE.test(c) && inAll(c));
    const fromText = chunks(query).filter(inAll);
    include = [...new Set([code, ...sizes, ...fromText].filter(Boolean))];
    // Nada em comum com o texto (ex.: escolheu algo bem diferente): usa as primeiras palavras do título.
    if (!include.length) include = chunks(titles[0]).filter(inAll).slice(0, 4);
    // Outros resultados que as regras ainda aceitariam (ex.: detergente Ypê limão quando escolheu maçã):
    // acrescenta até 2 palavras dos escolhidos que separam um do outro.
    const chosenKeys = new Set(titles.map(titleKey));
    let rivals = others.filter((t) => !chosenKeys.has(titleKey(t)) && include.every((term) => hasTerm(normalize(t), term)));
    const pool = chunks(titles[0]).filter((c) => inAll(c) && !include.includes(c) && !/^\d+$/.test(c));
    for (let added = 0; rivals.length && added < 2; added++) {
      const best = pool
        .map((c) => ({ c, left: rivals.filter((t) => normalize(t).includes(` ${c} `)).length }))
        .sort((a, b) => a.left - b.left)[0];
      if (!best || best.left === rivals.length) break; // nenhuma palavra ajuda
      include.push(best.c);
      pool.splice(pool.indexOf(best.c), 1);
      rivals = rivals.filter((t) => normalize(t).includes(` ${best.c} `));
    }
  } else {
    include = chunks(query);
  }

  const name = (titles[0] ? baseTitle(titles[0]) : query.charAt(0).toUpperCase() + query.slice(1)).slice(0, 90);
  const category = guessCategory(`${name} ${query}`);
  const varejo = chosen.some((c) => c.kind === 'varejo') || ['eletro', 'eletronicos'].includes(category);
  // "kit" e "miniatura" ficam de fora, a não ser que o item escolhido seja um kit.
  const exclude = ['kit', 'miniatura'].filter((t) => !titles.some((x) => normalize(x).includes(` ${t} `)));

  const product = {
    name,
    query: code && !normalize(query).includes(normalize(code)) ? `${query}; ${code}` : query,
    include,
    exclude,
    eans: [...new Set(chosen.map((c) => c.ean).filter(Boolean))],
    accepted: [...new Set(chosen.map((c) => c.extKey).filter(Boolean))],
    rejected: [],
    active: true,
    maxPrice: parseBRL(maxPrice),
    channels: varejo ? 'todos' : 'mercados',
    category,
  };
  // Conferência: as regras geradas precisam aceitar o que a pessoa escolheu.
  const misses = chosen.filter((c) => !evaluate({ ...product, accepted: [] }, { title: c.title, ean: c.ean, key: c.extKey }).match);
  return { product, image: chosen.find((c) => c.image)?.image ?? null, misses: misses.length };
}
