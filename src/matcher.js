// Decide se um item encontrado no site de um mercado é o produto que o usuário quer.
//
// Ordem de decisão:
//   1. rejeitado manualmente (chave mercado:id)  -> não
//   2. aceito manualmente ou EAN cadastrado      -> sim
//   3. contém algum termo proibido               -> não
//   4. contém todos os termos obrigatórios       -> sim
// Cada termo obrigatório aceita alternativas separadas por "|" (ex.: "malt|malts").
// Termo de várias palavras vale em qualquer ordem: "lava e seca samsung 13kg" confere com
// "Lava e Seca 13 Kg Samsung". Quantidade + unidade ("13 kg", "500 ml") fica junta.

export function normalize(text) {
  return ` ${String(text ?? '')
    // Tamanho de tela: 60", 60'', 60” e "60 pol" viram "60 polegadas" (e não se confundem com 60Hz).
    .replace(/(\d{2,3}(?:[.,]\d)?)\s*(?:"|''|”|″|pol\b\.?|polegadas?\b)/gi, ' $1 polegadas ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d)([a-z])/g, '$1 $2') // "12anos" -> "12 anos", "700ml" -> "700 ml"
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

// Palavras que não ajudam a identificar o produto.
export const STOPWORDS = new Set(['e', 'de', 'da', 'do', 'das', 'dos', 'com', 'para', 'a', 'o', 'as', 'os', 'em', 'na', 'no', 'nas', 'nos', 'um', 'uma', 'por']);
const UNIT = /^(?:kg|g|mg|ml|l|lt|litros?|un|und|unid|unidades?|w|v|gb|tb|mb|pol|polegadas|cm|mm|m|pcs|pecas|folhas|rolos|metros|cx|caixas?|pacotes?)$/;

/** Pedaços que identificam o produto: palavras e quantidades ("13 kg"), sem palavras vazias. */
export function chunks(text) {
  const words = normalize(text).trim().split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (/^\d+$/.test(words[i]) && UNIT.test(words[i + 1] ?? '')) out.push(`${words[i]} ${words[++i]}`);
    else if (!STOPWORDS.has(words[i])) out.push(words[i]);
  }
  return out;
}

// Frase exata (usada nos termos proibidos, para não descartar por palavras soltas).
const hasPhrase = (haystack, term) => haystack.includes(normalize(term));

/**
 * Palavra no texto já normalizado, aceitando a mesma palavra escrita junta ou separada:
 * "microondas" acha "micro-ondas" (normalizado "micro ondas"), "airfryer" acha "air fryer".
 * Retorna a posição (índice da palavra no texto) ou -1.
 */
export function wordAt(haystack, w) {
  const t = haystack.trim().split(' ');
  if (w.includes(' ')) {
    const parts = w.split(' ');
    for (let i = 0; i + parts.length <= t.length; i++) if (parts.every((p, j) => t[i + j] === p)) return i;
    return -1;
  }
  for (let i = 0; i < t.length; i++) {
    if (t[i] === w) return i;
    if (w.length >= 6 && i + 1 < t.length && t[i] + t[i + 1] === w) return i;
  }
  return -1;
}
export const hasWord = (haystack, w) => wordAt(haystack, w) >= 0;

// Frase exata ou todos os pedaços presentes, em qualquer ordem (palavra junta ou separada vale igual).
export function hasTerm(haystack, term) {
  if (hasPhrase(haystack, term)) return true;
  const words = normalize(term).trim().split(' ').filter(Boolean);
  // "micro ondas" (separado) também acha "microondas" (junto).
  if (words.length === 2 && hasWord(haystack, words.join(''))) return true;
  const parts = chunks(term);
  if (parts.length === 1) return hasWord(haystack, parts[0]);
  return parts.length > 1 && parts.every((p) => hasWord(haystack, p));
}

// Voltagem: 110V e 127V são a mesma rede. Termo "127v" aceita 110V, 127V, bivolt e título sem
// voltagem (a loja vende as duas versões com o mesmo nome); recusa só 220V. O inverso para "220v".
const VOLT_TERM = /^\s*(110|127|220)\s*v(?:olts?)?\s*$/i;
function titleVoltages(text) {
  const v = new Set();
  for (const m of text.matchAll(/ (110|127|220) v(?:olts?)? /g)) v.add(m[1] === '220' ? '220' : '127');
  if (text.includes(' bivolt ')) v.add('127').add('220');
  return v;
}
function voltageOk(text, term) {
  const want = term.match(VOLT_TERM)[1] === '220' ? '220' : '127';
  const has = titleVoltages(text);
  return !has.size || has.has(want);
}
const termOk = (text, alt) => (VOLT_TERM.test(alt) ? voltageOk(text, alt) : hasTerm(text, alt));

export function evaluate(product, { title, ean, key }) {
  if (key && product.rejected.includes(key)) return { match: false, reason: 'Descartado manualmente' };
  if (key && product.accepted.includes(key)) return { match: true, reason: 'Aceito manualmente' };
  if (ean && product.eans.includes(String(ean))) return { match: true, reason: 'EAN confere' };

  const text = normalize(title);
  const banned = product.exclude.find((t) => t.trim() && hasPhrase(text, t));
  if (banned) return { match: false, reason: `Contém "${banned}"` };

  const missing = product.include.filter((t) => t.trim() && !t.split('|').some((alt) => termOk(text, alt)));
  if (missing.length) return { match: false, reason: `Falta: ${missing.map((m) => `"${m}"`).join(', ')}` };

  return { match: true, reason: 'Termos conferem' };
}

// Termos pesquisados em cada site: cada busca informada (separadas por ";") e,
// como rede de segurança, o primeiro termo obrigatório (ex.: "macallan").
// Buscas completas às vezes escondem o item certo; a busca curta traz a lista inteira da marca.
export function searchTerms(product) {
  const queries = product.query.split(';').map((q) => q.trim());
  const short = product.include[0]?.split('|')[0]?.trim();
  return [...new Set([...queries, short].filter(Boolean))];
}

// Executa a busca para cada termo e concatena os resultados.
export async function searchAll(product, search) {
  const all = [];
  for (const term of searchTerms(product)) all.push(...(await search(term)));
  return all;
}
