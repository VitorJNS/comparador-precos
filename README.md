# Radar de Preços

Monitora produtos específicos nos sites de mercados, rankeia do mais barato ao mais caro
(por loja e por região) e avisa por e-mail quando o preço cai, entra em promoção, volta ao
estoque ou bate o menor valor já registrado.

Roda de dois jeitos: **na Vercel** (online 24h, banco Neon) ou **no seu PC**.

## Na Vercel (produção)

1. **Neon:** crie um projeto grátis em <https://neon.tech>, na região **AWS São Paulo (sa-east-1)**.
   Em *Connect*, copie a *connection string* e coloque em `DATABASE_URL` no `.env`.
2. **Migrar os dados** do banco local para o Neon (produtos, histórico, alertas):
   `npm run migrar`
3. **Vercel:** `npx vercel login` (uma vez) e depois `npx vercel link` nesta pasta.
4. **Variáveis** (Vercel → Project → Settings → Environment Variables):
   `DATABASE_URL`, `SMTP_USER`, `SMTP_PASS`, `CRON_SECRET` e, se quiser, `ADMIN_EMAIL` e `EMAIL_PARA`.
5. **Deploy:** `npx vercel deploy --prod` (ou `npm run deploy`).

Como funciona lá:
- Funções na região **São Paulo** (`gru1`), com limite de 5 minutos por execução. A coleta é dividida:
  cada loja roda numa execução própria e, perto do limite, continua numa nova execução de onde parou.
  A última loja a terminar envia o e-mail.
- **Agendamento:** o GitHub Actions (`.github/workflows/coleta-6h.yml`) dispara a coleta às 00h, 06h, 12h e 18h
  (pode atrasar alguns minutos). O cron da Vercel (`vercel.json`, 1x por dia no plano grátis) fica de reserva.
- As rotas de coleta sempre exigem `CRON_SECRET`.

## Login e pessoas

- Cada pessoa entra com o próprio e-mail: o painel manda um **link de acesso** (vale 30 min, uso único). Não há senha.
- Só entra quem foi **convidado**. Quem administra convida em **Pessoas** (fim da tela inicial); o convite vale 7 dias.
- Cada pessoa tem a **própria lista de produtos** e recebe e-mail só dos produtos dela, só das lojas da região
  escolhida em **Sua conta**. Um produto pode estar na lista de várias pessoas; a coleta roda uma vez só.
- Remover um produto tira da sua lista; o histórico só é apagado quando mais ninguém monitora.
- **Primeira vez** (migração): quem administra é `ADMIN_EMAIL` (ou, se vazio, `SMTP_USER`). Os e-mails de
  `EMAIL_PARA` viram pessoas cadastradas. Todos começam com os produtos que já existiam.
  Depois disso, `EMAIL_PARA` não é mais usado: gerencie pelo painel.
- No PC sem e-mail configurado, o link aparece na própria tela (e no terminal).

## No seu PC

```bash
npm install        # só na primeira vez
npm run dev        # abre o painel em http://localhost:3000
```

Ou dê dois cliques em `iniciar.bat`.

- Com `DATABASE_URL` no `.env`, usa o mesmo banco Neon da Vercel. Sem ela, usa um Postgres embutido
  (PGlite) em `data/pglite`.
- **Atualizar agora** roda uma coleta na hora (alguns minutos).
- Sem `DATABASE_URL`, com o app aberto, a coleta roda sozinha a cada `intervaloHoras` (padrão: 6h). Com o
  banco Neon de produção, o PC não coleta sozinho (quem agenda é o GitHub Actions); "Atualizar agora" funciona.
- Para iniciar junto com o Windows: `powershell -ExecutionPolicy Bypass -File .\iniciar-com-windows.ps1`

Outros comandos: `npm run coletar` (coleta sem abrir o painel), `npm run testar-email`.

**Desenvolvimento:** `npm run dev` usa o nodemon para reiniciar o servidor sozinho quando algo
em `src/`, `config/` ou no `.env` muda. Mudanças em `public/` (painel) só precisam de F5 no navegador.
Se o servidor reiniciar no meio de uma coleta, ela fica como "interrompida" e roda de novo na próxima vez.

## Alertas por e-mail (Gmail)

1. Ative a verificação em 2 etapas na sua conta Google.
2. Crie uma **senha de app** em <https://myaccount.google.com/apppasswords>.
3. Copie `.env.example` para `.env` e cole a senha em `SMTP_PASS` (na Vercel, cadastre como variável).
4. Clique em **Enviar resumo agora** no painel para testar.

## Adicionar produtos

Clique em **+ Produto**. São três passos, pensados para qualquer pessoa usar:

1. **O que você quer acompanhar?** Escreva como procuraria no Google (ex.: `detergente Ypê 500ml`).
2. **Toque no produto** na lista com fotos que vem das lojas (cerca de 5 s). Dá para escolher o mesmo
   produto em lojas diferentes. Os que estão sem estoque ficam numa parte recolhida.
   Não achou? **Acompanhar mesmo assim** cadastra pelo texto e avisa quando aparecer.
3. **Quando avisar:** sempre que cair, ou só abaixo de um preço.

O app monta as regras sozinho (`src/finder.js`): o código do modelo (ex.: `wd13fg`), a medida
(`500 ml`, `13 kg`), as palavras do texto que estão nos itens escolhidos e, se a busca trouxe
parecidos (outros sabores, outras cores), a palavra que separa o escolhido (ex.: `maçã`).
Os itens escolhidos e os códigos de barras deles ficam aceitos direto. Logo depois de salvar, o
produto é buscado em todas as lojas (cerca de 30 s), sem esperar a próxima coleta.

Termos de várias palavras conferem em qualquer ordem: `lava e seca samsung 13kg` aceita
"Lava e Seca 13 Kg Samsung". Quantidade e unidade ficam juntas (`13 kg` não confunde com `13 programas`).

**Ajustes avançados** (no 1º passo, ou em **Editar** na página do produto) abre o formulário completo:

| Campo | Para que serve |
|---|---|
| Termo de busca | O que é digitado na busca de cada site. Várias buscas: separe por `;`. |
| Termos obrigatórios | Todos precisam aparecer no nome do item. `malt\|malts` aceita qualquer um. |
| Termos proibidos | Descarta itens com esses termos (ex.: `kit`, `miniatura`, `50 ml`). |
| EAN | Código de barras. Quando o site informa o EAN, a correspondência é exata. |
| Categoria | Aba em que o produto aparece (Bebidas, Eletrodomésticos, Eletrônicos, Limpeza, Casa e cozinha, Outros). "Automática" escolhe pelo nome; as regras ficam em `src/categories.js`. |

Na página do produto, **Itens descartados** lista o que a busca encontrou mas o filtro rejeitou.
Use **É este** para incluir um item, ou o **×** no ranking para excluir um que não é o produto certo.

## Mercados

| Mercado | Como coleta | Preço por loja/região |
|---|---|---|
| Sam's Club | API VTEX + simulação de carrinho por CEP | Sim |
| Atacadão | API VTEX + simulação de carrinho por CEP | Sim |
| Carrefour | Carrefour Mercado (VTEX, por CEP) | Sim |
| Pão de Açúcar | API GPA, busca em cada loja que entrega nos CEPs | Sim |
| Pague Menos | Página de busca do superpaguemenos.com.br | Preço único do site |
| Tenda Atacado | Página de busca do tendaatacado.com.br | Preço único do site |
| Covabra | API VTEX + simulação de carrinho por CEP (região de Campinas e Indaiatuba) | Sim |
| Assaí, Sumerbol | Não suportados: não vendem online, só publicam encartes em imagem | — |
| **Varejo:** Brastemp, Electrolux, Fast Shop, Samsung | API VTEX, só o que a própria loja vende | Preço nacional do site |
| **Varejo (lojas de marca):** Consul, Compra Certa (Whirlpool), KitchenAid, Oster, Arno, Philco, Britânia, Mondial, Cadence, Panasonic, Midea, Polishop, Elgin | API VTEX, só o que a própria fabricante vende. Cada loja só tem a própria marca | Preço nacional do site |
| **Varejo:** KaBuM! | API de busca do KaBuM, só o que o próprio KaBuM vende | Preço nacional do site |
| **Varejo:** Magalu | Ofertas vendidas e entregues pela Magalu dentro do KaBuM (mesmo grupo) e dentro da Americanas. O site magazineluiza.com.br bloqueia acesso automatizado | Preço nacional do site |
| **Varejo:** Americanas | API VTEX + simulação de carrinho (a busca não traz preço), só a própria Americanas e a Magalu; demais parceiros ficam de fora. Preço "de" mais de 60% acima do atual é ignorado (inflado por vendedores) | Preço nacional do site |
| Amazon | Não suportado: bloqueia acesso automatizado (verificação anti-robô) | — |

Por padrão, cada produto só é comparado em supermercados. Marketplaces (carrefour.com.br, lojas parceiras
do Pão de Açúcar e do Tenda) ficam de fora de propósito. No formulário do produto, "Onde buscar" →
"Supermercados + lojas de varejo" inclui também Brastemp, Electrolux, Fast Shop, Samsung, KaBuM, Magalu, Americanas e as lojas de marca acima
(usado nas geladeiras, TV e eletroportáteis).

Ao cadastrar um produto, o app já procura uma imagem dele nas lojas (a primeira que conferir com os termos).
Para remover um produto, use o ícone de lixeira no card (aparece ao passar o mouse) ou **Excluir** na página dele.

Os CEPs de cada região ficam em `config/settings.json`. Adicionar CEPs revela mais lojas.
Só ofertas disponíveis aparecem no painel e nos e-mails. As sem estoque seguem monitoradas (para o
alerta de "voltou ao estoque"), e produtos sem nenhuma oferta disponível ficam fora da lista até aparecer uma.

## Estrutura

```
config/            settings.json (regiões, CEPs, intervalo) e produtos iniciais
src/markets/       um coletor por mercado (vtex.js é compartilhado)
src/matcher.js     regras que decidem se um item é o produto procurado
src/collector.js   coletas em partes (retomáveis), histórico e detecção de alterações
src/notifier.js    e-mails
src/db.js          Postgres: Neon (DATABASE_URL) ou PGlite local
src/app.js         API (a mesma no PC e na Vercel), login e cron
src/server.js      servidor local + agendador
api/index.js       função da Vercel
public/            painel web
scripts/           migração do banco SQLite antigo
```

Se um site mudar e o coletor quebrar, o painel mostra o mercado como **Com erro** na seção
Mercados, e os outros continuam funcionando.

Requisitos: Node.js 22 ou superior.
