// Cadastro simplificado: a pessoa procura em palavras dela, escolhe o produto pela foto
// e o app monta sozinho as regras de busca (termos, código do modelo, EAN, canais).

import { chunks, evaluate, hasTerm, normalize, wordAt } from './matcher.js';
import { baseTitle, titleKey } from './queries.js';
import { guessCategory } from './categories.js';

const SIZE = /^\d+ [a-z]+$/; // "13 kg", "500 ml" (já juntos por chunks)
const MAX_GROUPS = 60; // exatos (têm todas as palavras); a tela mostra aos poucos ("mostrar mais")
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
const isPart = (t) => t.trim().split(' ').slice(0, 2).some((w) => PARTS.has(w));

// ---------- sinônimos e erros de digitação ----------

// Cada linha: jeitos diferentes de escrever a mesma coisa (já normalizados).
const SYNONYM_GROUPS = [
  ['geladeira', 'refrigerador'],
  ['tv', 'televisao', 'televisor'],
  ['ar condicionado', 'split', 'condicionador de ar'],
  ['air fryer', 'fritadeira eletrica', 'fritadeira sem oleo'],
  ['lava e seca', 'lavadora e secadora', 'lava seca'],
  ['maquina de lavar', 'lavadora', 'lava roupas'],
  ['notebook', 'laptop'],
  ['celular', 'smartphone'],
  ['aspirador', 'aspirador de po'],
  ['freezer', 'congelador'],
  ['cafeteira', 'maquina de cafe'],
  ['papel higienico', 'papel toalete'],
];

// Palavras conhecidas, para corrigir digitação de 1 letra ("geladera" -> "geladeira").
const DICTIONARY = new Set([
  ...SYNONYM_GROUPS.flat().flatMap((p) => p.split(' ')).filter((w) => w.length >= 4),
  ...('geladeira fogao microondas liquidificador batedeira planetaria cafeteira aspirador ventilador televisao notebook celular ' +
    'smartphone detergente amaciante sabao desinfetante sanitaria alvejante limpador multiuso esponja cafe arroz feijao acucar oleo ' +
    'leite cerveja whisky vinho vodka lavadora secadora freezer purificador bebedouro fritadeira panela sofa colchao travesseiro ' +
    'impressora monitor tablet fralda shampoo condicionador sabonete papel toalha lixeira talheres frigideira sanduicheira torradeira ' +
    'chaleira espremedor processador mixer grill forno cooktop coifa depurador adega climatizador umidificador aquecedor ferro secador ' +
    'chapinha barbeador inverter frost duplex branca branco preta preto inox prata cinza vermelha vermelho smart digital eletrica ' +
    'samsung brastemp electrolux consul philco mondial britania oster arno panasonic midea philips walita motorola xiaomi apple iphone ' +
    'galaxy kitchenaid cadence polishop elgin tramontina pilao nescafe macallan').split(' '),
]);

// Distância de edição com troca de letras vizinhas ("samsumg" -> "samsung" vale 1). Para em max+1.
function distance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const closeTo = (w, candidate) => w.length >= 5 && w[0] === candidate[0] && distance(w, candidate) <= 1;

/**
 * Prepara o texto da pessoa: corrige palavras com 1 letra errada e lista buscas alternativas
 * para as lojas (sinônimos, versão curta). Retorna { text, corrected, alternatives }.
 */
export function prepareQuery(raw) {
  const words = normalize(raw).trim().split(' ').filter(Boolean);
  let corrected = false;
  const fixed = words.map((w) => {
    if (w.length < 5 || DICTIONARY.has(w) || /\d/.test(w)) return w;
    const hit = [...DICTIONARY].find((d) => closeTo(w, d));
    if (hit) corrected = true;
    return hit ?? w;
  });
  const text = corrected ? fixed.join(' ') : String(raw).trim();
  const q = ` ${fixed.join(' ')} `;
  const alternatives = new Set();
  // Sinônimos: troca o termo pelo jeito mais comum de escrever ("refrigerador" -> "geladeira").
  for (const group of SYNONYM_GROUPS) {
    const found = group.find((p) => q.includes(` ${p} `));
    if (found && found !== group[0]) alternatives.add(q.replace(` ${found} `, ` ${group[0]} `).trim());
  }
  // Versão curta para lojas que não acham nada com frase longa: código do modelo, ou as 2 primeiras palavras.
  const code = modelCodes(raw)[0];
  if (code) alternatives.add(code);
  const plain = chunks(text).filter((c) => !SIZE.test(c));
  if (plain.length > 2) alternatives.add(plain.slice(0, 2).join(' '));
  alternatives.delete(normalize(text).trim());
  return { text, corrected, alternatives: [...alternatives] };
}

// "Conceitos" do texto: cada palavra, ou um termo de várias palavras com os sinônimos dele.
function concepts(text) {
  let q = ` ${normalize(text).trim()} `;
  const out = [];
  for (const group of SYNONYM_GROUPS) {
    const found = [...group].sort((a, b) => b.length - a.length).find((p) => q.includes(` ${p} `));
    if (!found) continue;
    out.push({ label: found, alts: group, first: q.indexOf(` ${found} `) });
    q = q.replace(` ${found} `, ' ');
  }
  for (const c of chunks(q)) out.push({ label: c, alts: [c], first: q.indexOf(` ${c} `) });
  return out.sort((a, b) => a.first - b.first);
}

// Posição do conceito no título (qualquer sinônimo; palavra com 1 letra errada também vale). -1 se não tem.
function conceptAt(t, concept) {
  for (const alt of concept.alts) {
    const pos = wordAt(t, alt);
    if (pos >= 0) return { pos, fuzzy: false };
  }
  if (concept.alts.length === 1 && !concept.label.includes(' ')) {
    const tokens = t.trim().split(' ');
    const i = tokens.findIndex((tok) => closeTo(concept.label, tok));
    if (i >= 0) return { pos: i, fuzzy: true };
  }
  return { pos: -1, fuzzy: false };
}

/**
 * Relevância do título para o texto da pessoa.
 *   score: +10 por palavra (+6 se só bateu com 1 letra diferente); a 1ª palavra buscada como 1ª do
 *          título vale +8 (é o tipo do produto: "Geladeira Electrolux…"), como 2ª vale +3 ("Smart TV…");
 *          -12 se ela vem depois de "para/de/com…" (acessório ou alimento "para" aquilo);
 *          brinquedo/miniatura -15; título que começa com nome de peça -20.
 *   missing: palavras do texto que o título não tem.
 * brand: loja de marca única; a marca conta como presente mesmo se o título não a repete.
 */
function relevance(list, text, title, brand = null) {
  const t = normalize(title);
  const tokens = t.trim().split(' ');
  const query = normalize(text);
  const withBrand = brand ? `${t}${normalize(brand).trim()} ` : t;
  let score = 0;
  const missing = [];
  list.forEach((c, idx) => {
    const { pos, fuzzy } = conceptAt(t, c);
    if (pos < 0) {
      if (conceptAt(withBrand, c).pos >= 0) score += 10;
      else missing.push(c.label);
      return;
    }
    score += fuzzy ? 6 : 10;
    const prev = tokens[pos - 1];
    // "pão de queijo": o "de" faz parte do que a pessoa digitou, não é modificador.
    if (MODIFIERS.has(prev) && !query.includes(` ${prev} ${c.label.split(' ')[0]}`)) score -= 12;
    else if (idx === 0) score += pos === 0 ? 8 : pos === 1 ? 3 : 0;
  });
  for (const w of TOY) if (t.includes(` ${w} `) && !query.includes(` ${w} `)) score -= 15;
  if (tokens.slice(0, 2).some((w) => PARTS.has(w) && !query.includes(` ${w} `))) score -= 20;
  return { score, missing };
}

// Palavra legível para "não tem: …" (a medida volta a ficar junta: "13 kg" -> "13kg").
const label = (w) => w.replace(/^(\d+) ([a-z]+)$/, '$1$2');

// ---------- variações (cor e voltagem) e marca ----------

const COLORS = [
  ['Branca', ['branca', 'branco', 'white']],
  ['Preta', ['preta', 'preto', 'black']],
  ['Inox', ['inox']],
  ['Prata', ['prata', 'silver']],
  ['Cinza', ['cinza', 'grafite', 'titanium', 'titanio', 'chumbo']],
  ['Vermelha', ['vermelha', 'vermelho', 'red']],
  ['Azul', ['azul', 'blue']],
  ['Rosa', ['rosa', 'pink']],
  ['Verde', ['verde']],
  ['Bege', ['bege', 'marfim', 'creme']],
  ['Dourada', ['dourada', 'dourado', 'gold']],
];
export const COLOR_ALIASES = Object.fromEntries(COLORS);

function colorOf(title) {
  const t = normalize(title);
  const found = COLORS.filter(([, aliases]) => aliases.some((a) => t.includes(` ${a} `))).map(([name]) => name);
  if (found.includes('Preta') && found.includes('Inox')) return 'Black Inox';
  return found[0] ?? null;
}

function voltageOf(title) {
  const t = normalize(title);
  if (t.includes(' bivolt ')) return 'Bivolt';
  const low = / (110|127) v(?:olts?)? /.test(t);
  const high = / 220 v(?:olts?)? /.test(t);
  if (low && high) return null; // "110V/220V": não dá para saber
  return low ? '127V' : high ? '220V' : null;
}

const KNOWN_BRANDS = [
  'samsung', 'lg', 'brastemp', 'consul', 'electrolux', 'philco', 'mondial', 'britania', 'oster', 'arno', 'panasonic', 'midea',
  'philips', 'walita', 'kitchenaid', 'cadence', 'elgin', 'tcl', 'sony', 'motorola', 'xiaomi', 'apple', 'multilaser', 'hisense',
  'ype', 'omo', 'pilao', 'nescafe', 'tramontina', 'black decker', 'wap', 'gree', 'fischer', 'esmaltec', 'suggar', 'agratto',
];
function brandOf(item) {
  if (item.brand) return item.brand;
  const t = normalize(item.title);
  const b = KNOWN_BRANDS.find((x) => t.includes(` ${x} `));
  return b ? b.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

// Códigos de modelo no título: letras e números juntos (WD13FG, BRO85AK, OBAT641, 60UA85),
// sem contar medidas como 13kg, 500ml ou 220V.
function modelCodes(title) {
  return String(title)
    .split(/[\s\-/(),.+]+/)
    .filter((t) => t.length >= 4 && /[a-z]/i.test(t) && /\d/.test(t) && !/^\d+[a-z]+$/i.test(t))
    .map((t) => t.toLowerCase());
}

// Tira as palavras de cor do título (cartão que junta várias cores).
function withoutColors(title) {
  const words = COLORS.flatMap(([, a]) => a);
  return title
    .split(/\s+/)
    .filter((w) => !words.includes(normalize(w).trim()))
    .join(' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Junta os resultados das lojas em grupos para a tela de escolha. O mesmo aparelho vira um cartão:
 * mesmo EAN, mesmo título ou mesmo código do modelo (WD13FG da Samsung, da Fast Shop e da Americanas,
 * em qualquer cor ou voltagem). Peças nunca entram no grupo do aparelho pelo código.
 * Só entram itens com todas as palavras do texto (missing = []) ou, como "parecidos", com uma a menos.
 * Cada grupo traz as variações (cores e voltagens) e a marca, para os botões e o filtro da tela.
 */
export function groupResults(text, items) {
  const list = concepts(text);
  const allowMissing = list.length >= 2 ? 1 : 0;
  const groups = new Map();
  const keyOf = new Map(); // "ean:...", "t:..." ou "m:código" -> grupo
  const codeIndex = []; // [código, grupo] para juntar por começo comum (wd13fg = wd13fg6b34be)
  for (const it of items) {
    if (!it.title) continue;
    const { score, missing } = relevance(list, text, it.title, it.brand);
    if (missing.length > allowMissing) continue;
    const part = isPart(normalize(it.title));
    const codes = part ? [] : modelCodes(it.title);
    const ids = [`t:${titleKey(it.title)}`, ...(it.ean ? [`ean:${it.ean}`] : []), ...codes.map((c) => `m:${c}`)];
    let key = ids.map((k) => keyOf.get(k)).find(Boolean);
    if (!key) {
      for (const c of codes) {
        const hit = codeIndex.find(([k]) => Math.min(k.length, c.length) >= 5 && (k.startsWith(c) || c.startsWith(k)));
        if (hit) {
          key = hit[1];
          break;
        }
      }
    }
    key ??= ids[0];
    for (const k of ids) keyOf.set(k, key);
    for (const c of codes) codeIndex.push([c, key]);
    if (!groups.has(key)) groups.set(key, { key, title: it.title, score, missing, codes: new Set(), items: [] });
    const g = groups.get(key);
    if (score > g.score) {
      g.score = score;
      g.title = it.title;
    }
    if (missing.length < g.missing.length) g.missing = missing;
    for (const c of codes) g.codes.add(c);
    g.items.push({ ...it, color: colorOf(it.title), voltage: voltageOf(it.title), brand: brandOf(it) });
  }
  const out = [...groups.values()].map((g) => {
    const inStock = g.items.filter((i) => i.available && i.price);
    const priced = (inStock.length ? inStock : g.items).filter((i) => i.price).sort((a, b) => a.price - b.price);
    const markets = [...new Map(g.items.map((i) => [i.market, i.marketName])).values()];
    const colors = [...new Set(g.items.map((i) => i.color).filter(Boolean))];
    const volts = [...new Set(g.items.map((i) => i.voltage).filter((v) => v && v !== 'Bivolt'))].sort();
    const codes = [...g.codes].sort((a, b) => a.length - b.length);
    return {
      key: g.key,
      title: colors.length > 1 ? withoutColors(baseTitle(g.title)) : baseTitle(g.title),
      image: (inStock.find((i) => i.image) ?? g.items.find((i) => i.image))?.image ?? null,
      score: g.score,
      missing: g.missing.map(label),
      available: inStock.length > 0,
      price: priced[0]?.price ?? null,
      approximate: priced[0]?.approximate ?? false,
      markets,
      brand: g.items.map((i) => i.brand).find(Boolean) ?? null,
      model: codes[0]?.toUpperCase() ?? null,
      variants: { colors, volts },
      // O que o cadastro precisa de cada item escolhido.
      items: g.items.map((i) => ({
        market: i.market, kind: i.kind, extKey: i.extKey, ean: i.ean, title: i.title, image: i.image,
        color: i.color, voltage: i.voltage, available: !!i.available,
      })),
    };
  });
  // Exatos primeiro; depois mais relevante; o preço só desempata entre itens igualmente relevantes.
  out.sort((a, b) => a.missing.length - b.missing.length || b.score - a.score || b.available - a.available || (a.price ?? Infinity) - (b.price ?? Infinity));
  const exact = out.filter((g) => !g.missing.length).slice(0, MAX_GROUPS);
  const similar = out.filter((g) => g.missing.length).slice(0, MAX_SIMILAR);
  return [...exact, ...similar];
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
 * variants: { colors, volts } quando a pessoa escolheu só algumas cores/voltagens do modelo
 * (vira termo obrigatório, para outras lojas também respeitarem a escolha).
 */
export function buildProduct(text, chosen = [], { maxPrice = null, others = [], variants = null } = {}) {
  const query = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!query) throw new Error('Escreva o que você quer acompanhar');
  const titles = chosen.map((c) => c.title);
  const inAll = (chunk) => titles.every((t) => normalize(t).includes(` ${chunk} `));

  let include;
  let code = null;
  if (titles.length) {
    code = commonModelCode(titles);
    // Medidas que todos os escolhidos têm (13 kg, 500 ml) + palavras do texto que estão em todos.
    // (voltagem não é medida: "127 v" fica de fora; ela só entra se a pessoa escolher uma voltagem.)
    const sizes = chunks(titles[0]).filter((c) => SIZE.test(c) && !/ v$/.test(c) && inAll(c));
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
    // Só algumas cores ou só uma voltagem: vira termo (uma das cores escolhidas; a voltagem).
    if (variants?.colors?.length) {
      const aliases = variants.colors.flatMap((c) => (c === 'Black Inox' ? ['black inox'] : COLOR_ALIASES[c] ?? [normalize(c).trim()]));
      include.push([...new Set(aliases)].join('|'));
    }
    if (variants?.volts?.length === 1) include.push(variants.volts[0].toLowerCase());
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
