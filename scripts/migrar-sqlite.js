// Copia os dados do banco antigo (data/precos.db, SQLite) para o Postgres:
// o Neon, se DATABASE_URL estiver no .env; senão, o PGlite local.
//   node --env-file-if-exists=.env scripts/migrar-sqlite.js [--forcar]
// Por segurança, só roda se o destino ainda não tiver coletas (use --forcar para sobrescrever).

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, q, one, insertMany, dbKind } from '../src/db.js';

const SRC = join(ROOT, 'data', 'precos.db');
if (!existsSync(SRC)) {
  console.log('Não há banco antigo em data/precos.db; nada a migrar.');
  process.exit(0);
}

const src = new DatabaseSync(SRC, { readOnly: true });
const target = await dbKind();
const runs = await one('SELECT COUNT(*)::int AS n FROM runs');
if (runs.n > 0 && !process.argv.includes('--forcar')) {
  console.error(`O destino (${target}) já tem ${runs.n} coletas. Rode com --forcar para apagar e copiar de novo.`);
  process.exit(1);
}

await q('TRUNCATE products, runs, run_markets, observations, offers, candidates, events, kv RESTART IDENTITY CASCADE');

const TABLES = {
  products: ['id', 'name', 'query', 'include_terms', 'exclude_terms', 'eans', 'accepted', 'rejected', 'active', 'max_price', 'channels', 'created_at'],
  runs: ['id', 'started_at', 'finished_at', 'status', 'trigger'],
  run_markets: ['run_id', 'market', 'status', 'offers', 'error', 'ms'],
  offers: ['product_id', 'market', 'store_id', 'store_name', 'regions', 'title', 'url', 'image', 'ext_key', 'ean', 'price', 'list_price', 'available', 'note', 'first_seen', 'seen_at', 'changed_at'],
  observations: ['id', 'run_id', 'product_id', 'market', 'store_id', 'price', 'list_price', 'available', 'collected_at'],
  candidates: ['product_id', 'market', 'ext_key', 'title', 'price', 'url', 'image', 'ean', 'reason'],
  events: ['id', 'run_id', 'product_id', 'market', 'store_id', 'store_name', 'type', 'old_price', 'new_price', 'list_price', 'url', 'created_at', 'emailed'],
  kv: ['key', 'value'],
};

const productIds = new Set(src.prepare('SELECT id FROM products').all().map((r) => r.id));
for (const [table, cols] of Object.entries(TABLES)) {
  let rows = src.prepare(`SELECT ${cols.join(',')} FROM ${table}`).all();
  // Linhas de produtos já excluídos (sobras do SQLite) quebrariam as chaves estrangeiras.
  if (cols.includes('product_id')) rows = rows.filter((r) => productIds.has(r.product_id));
  if (table === 'run_markets') rows = rows.map((r) => ({ ...r, status: r.status === 'running' ? 'erro' : r.status }));
  if (table === 'runs') rows = rows.map((r) => ({ ...r, status: r.status === 'running' ? 'interrompida' : r.status }));
  await insertMany(table, cols, rows.map((r) => cols.map((c) => r[c] ?? null)));
  console.log(`${table.padEnd(13)} ${rows.length} linhas`);
}

// Os contadores automáticos (SERIAL) continuam depois do maior id copiado.
for (const table of ['products', 'runs', 'observations', 'events']) {
  await q(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
}
console.log(`\nMigração concluída para ${target === 'neon' ? 'o Neon' : 'o PGlite local'}.`);
process.exit(0);
