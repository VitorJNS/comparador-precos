// Categorias dos produtos (abas do painel). A ordem aqui é a ordem das abas.
// Produto sem categoria escolhida recebe uma sugestão pelo nome.

export const CATEGORIES = [
  { id: 'bebidas', name: 'Bebidas', test: /whisky|macallan|salute|chivas|johnnie|glen|vinho|cerveja|\bgin\b|vodka|licor|cacha[cç]a|espumante|champagne/i },
  { id: 'eletro', name: 'Eletrodomésticos', test: /geladeira|refrigerador|freezer|liquidificador|batedeira|air ?fryer|fritadeira|cafeteira|micro-?ondas|lava|fog[aã]o|aspirador|ventilador|ar.condicionado/i },
  { id: 'eletronicos', name: 'Eletrônicos', test: /\btv\b|televis|tablet|notebook|celular|smartphone|galaxy|iphone|monitor|fone|console|videogame/i },
  { id: 'casa', name: 'Casa e cozinha', test: /sof[aá]|lixeira|talher|prato|panela|toalha|cama|colch[aã]o|mesa|cadeira|copo|ta[cç]a/i },
  { id: 'outros', name: 'Outros', test: null },
];

const IDS = new Set(CATEGORIES.map((c) => c.id));

export const isCategory = (id) => IDS.has(id);

export function guessCategory(name) {
  return CATEGORIES.find((c) => c.test?.test(String(name ?? '')))?.id ?? 'outros';
}
