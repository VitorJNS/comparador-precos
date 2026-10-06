// Banco Postgres.
//   - Produção (Vercel) e também local, se DATABASE_URL estiver no .env: Neon (via HTTP).
//   - Local sem DATABASE_URL: PGlite, um Postgres embutido gravado em data/pglite.
// Todas as funções são assíncronas; o SQL usa parâmetros $1, $2...

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import settingsJson from '../config/settings.json' with { type: 'json' };
import seedJson from '../config/produtos-iniciais.json' with { type: 'json' };
import { guessCategory, isCategory } from './categories.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let client = null;

async function connect() {
  if (process.env.DATABASE_URL) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    return { query: (text, params) => sql.query(text, params), kind: 'neon' };
  }
  // Em deploy da Vercel (VERCEL_ENV existe) o banco precisa ser o Neon: o disco lá não é permanente.
  if (process.env.VERCEL_ENV) throw new Error('DATABASE_URL não configurada no projeto da Vercel');
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = join(ROOT, 'data', 'pglite');
  mkdirSync(dirname(dir), { recursive: true });
  const pg = new PGlite(dir);
  return { query: async (text, params) => (await pg.query(text, params)).rows, kind: 'pglite' };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS products (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    query         TEXT NOT NULL,
    include_terms TEXT NOT NULL DEFAULT '[]',
    exclude_terms TEXT NOT NULL DEFAULT '[]',
    eans          TEXT NOT NULL DEFAULT '[]',
    accepted      TEXT NOT NULL DEFAULT '[]',
    rejected      TEXT NOT NULL DEFAULT '[]',
    active        INTEGER NOT NULL DEFAULT 1,
    max_price     DOUBLE PRECISION,
    channels      TEXT NOT NULL DEFAULT 'mercados',
    created_at    TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id          SERIAL PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL DEFAULT 'running',
    trigger     TEXT NOT NULL DEFAULT 'agendado'
  )`,
  // Uma linha por loja em cada coleta. next_index permite continuar em outra execução.
  `CREATE TABLE IF NOT EXISTS run_markets (
    run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    market     TEXT NOT NULL,
    status     TEXT NOT NULL,
    offers     INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    ms         INTEGER,
    total      INTEGER NOT NULL DEFAULT 0,
    done       INTEGER NOT NULL DEFAULT 0,
    next_index INTEGER NOT NULL DEFAULT 0,
    current    TEXT,
    started_ms BIGINT,
    PRIMARY KEY (run_id, market)
  )`,
  `CREATE TABLE IF NOT EXISTS observations (
    id           SERIAL PRIMARY KEY,
    run_id       INTEGER NOT NULL,
    product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    market       TEXT NOT NULL,
    store_id     TEXT NOT NULL,
    price        DOUBLE PRECISION,
    list_price   DOUBLE PRECISION,
    available    INTEGER NOT NULL,
    collected_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS obs_product ON observations(product_id, collected_at)`,
  `CREATE TABLE IF NOT EXISTS offers (
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    market      TEXT NOT NULL,
    store_id    TEXT NOT NULL,
    store_name  TEXT NOT NULL,
    regions     TEXT NOT NULL,
    title       TEXT NOT NULL,
    url         TEXT,
    image       TEXT,
    ext_key     TEXT,
    ean         TEXT,
    price       DOUBLE PRECISION,
    list_price  DOUBLE PRECISION,
    available   INTEGER NOT NULL,
    note        TEXT,
    first_seen  TEXT NOT NULL,
    seen_at     TEXT NOT NULL,
    changed_at  TEXT NOT NULL,
    PRIMARY KEY (product_id, market, store_id)
  )`,
  `CREATE TABLE IF NOT EXISTS candidates (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    market     TEXT NOT NULL,
    ext_key    TEXT NOT NULL,
    title      TEXT NOT NULL,
    price      DOUBLE PRECISION,
    url        TEXT,
    image      TEXT,
    ean        TEXT,
    reason     TEXT,
    PRIMARY KEY (product_id, market, ext_key)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id         SERIAL PRIMARY KEY,
    run_id     INTEGER,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    market     TEXT,
    store_id   TEXT,
    store_name TEXT,
    type       TEXT NOT NULL,
    old_price  DOUBLE PRECISION,
    new_price  DOUBLE PRECISION,
    list_price DOUBLE PRECISION,
    url        TEXT,
    created_at TEXT NOT NULL,
    emailed    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS events_created ON events(created_at)`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`,
  // v2: imagem do produto, buscada nas lojas quando ele é cadastrado.
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS image TEXT`,
  // v3: categoria (abas do painel). Vazia = sugerida pelo nome.
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT`,
];
// Aumente quando mudar o SCHEMA: os bancos existentes rodam os comandos de novo uma vez.
const SCHEMA_VERSION = '3';

let ready = null;

// Conecta, cria as tabelas e cadastra os produtos iniciais (uma vez por processo).
function init() {
  ready ??= (async () => {
    client = await connect();
    // Banco já pronto (caso comum): duas consultas, em vez de recriar o schema a cada partida a frio.
    const [state] = await client.query(`SELECT to_regclass('public.kv') IS NOT NULL AS has_kv`, []);
    if (state.has_kv) {
      const [v] = await client.query(`SELECT value FROM kv WHERE key = 'schema'`, []);
      if (v?.value === SCHEMA_VERSION) return;
    }
    for (const stmt of SCHEMA) await client.query(stmt, []);
    await client.query(
      `INSERT INTO kv (key, value) VALUES ('schema', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SCHEMA_VERSION],
    );
    const seeded = await client.query(`SELECT value FROM kv WHERE key = 'seeded'`, []);
    if (!seeded.length) {
      for (const s of seedJson) {
        await saveProduct({ name: s.nome, query: s.busca, include: s.termosObrigatorios, exclude: s.termosProibidos, eans: s.eans });
      }
      await client.query(`INSERT INTO kv (key, value) VALUES ('seeded', 'true') ON CONFLICT (key) DO NOTHING`, []);
    }
  })().catch((err) => {
    ready = null; // tenta de novo na próxima chamada
    throw err;
  });
  return ready;
}

/** Executa uma consulta e devolve as linhas. */
export async function q(text, params = []) {
  await init();
  return client.query(text, params);
}

/** Primeira linha (ou null). */
export async function one(text, params = []) {
  return (await q(text, params))[0] ?? null;
}

export const dbKind = async () => (await init(), client.kind);

// Insere várias linhas numa consulta só (bem mais rápido pelo HTTP do Neon).
export async function insertMany(table, columns, rows, suffix = '') {
  if (!rows.length) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params = [];
    const values = part.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`);
    await q(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')} ${suffix}`, params);
  }
}

const parse = (s) => (s ? JSON.parse(s) : []);

export function rowToProduct(r) {
  return {
    id: r.id,
    name: r.name,
    query: r.query,
    include: parse(r.include_terms),
    exclude: parse(r.exclude_terms),
    eans: parse(r.eans),
    accepted: parse(r.accepted),
    rejected: parse(r.rejected),
    active: !!r.active,
    maxPrice: r.max_price ?? null,
    channels: r.channels ?? 'mercados',
    image: r.image ?? null,
    category: isCategory(r.category) ? r.category : guessCategory(r.name),
    createdAt: r.created_at,
  };
}

export async function setProductImage(id, image) {
  await q('UPDATE products SET image = $1 WHERE id = $2', [image, id]);
}

export async function listProducts({ onlyActive = false } = {}) {
  const rows = await q(`SELECT * FROM products ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY id`);
  return rows.map(rowToProduct);
}

export async function getProduct(id) {
  const r = await one('SELECT * FROM products WHERE id = $1', [id]);
  return r ? rowToProduct(r) : null;
}

export async function saveProduct(p) {
  const vals = [
    p.name,
    p.query,
    JSON.stringify(p.include ?? []),
    JSON.stringify(p.exclude ?? []),
    JSON.stringify(p.eans ?? []),
    JSON.stringify(p.accepted ?? []),
    JSON.stringify(p.rejected ?? []),
    p.active === false ? 0 : 1,
    p.maxPrice ?? null,
    p.channels === 'todos' ? 'todos' : 'mercados',
    isCategory(p.category) ? p.category : guessCategory(p.name),
  ];
  // Chamado também dentro do init (produtos iniciais), por isso usa o client direto.
  const run = (text, params) => (client ? client.query(text, params) : q(text, params));
  if (p.id) {
    await run(
      `UPDATE products SET name=$1, query=$2, include_terms=$3, exclude_terms=$4, eans=$5, accepted=$6, rejected=$7,
       active=$8, max_price=$9, channels=$10, category=$11 WHERE id=$12`,
      [...vals, p.id],
    );
    return p.id;
  }
  const rows = await run(
    `INSERT INTO products (name, query, include_terms, exclude_terms, eans, accepted, rejected, active, max_price, channels, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    vals,
  );
  return rows[0].id;
}

export function loadSettings() {
  return settingsJson;
}
