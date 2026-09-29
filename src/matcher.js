// Decide se um item encontrado no site de um mercado é o produto que o usuário quer.
//
// Ordem de decisão:
//   1. rejeitado manualmente (chave mercado:id)  -> não
//   2. aceito manualmente ou EAN cadastrado      -> sim
//   3. contém algum termo proibido               -> não
//   4. contém todos os termos obrigatórios       -> sim
// Cada termo obrigatório aceita alternativas separadas por "|" (ex.: "malt|malts").

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

const hasTerm = (haystack, term) => haystack.includes(normalize(term));

export function evaluate(product, { title, ean, key }) {
  if (key && product.rejected.includes(key)) return { match: false, reason: 'Descartado manualmente' };
  if (key && product.accepted.includes(key)) return { match: true, reason: 'Aceito manualmente' };
  if (ean && product.eans.includes(String(ean))) return { match: true, reason: 'EAN confere' };

  const text = normalize(title);
  const banned = product.exclude.find((t) => t.trim() && hasTerm(text, t));
  if (banned) return { match: false, reason: `Contém "${banned}"` };

  const missing = product.include.filter((t) => t.trim() && !t.split('|').some((alt) => hasTerm(text, alt)));
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
