// Servidor local: painel + API + agendador. Rode com: npm run dev  ->  http://localhost:3000
// (Na Vercel quem responde é api/index.js, e o agendamento é o cron do vercel.json.)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as normPath } from 'node:path';
import { ROOT, dbKind } from './db.js';
import { handle, localScheduleTick } from './app.js';
import { emailConfigured } from './notifier.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function staticFile(res, pathname) {
  const rel = normPath(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    const html = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
  }
}

const tick = () => localScheduleTick().catch((e) => console.error('Agendador:', e.message));
setTimeout(tick, 5000);
setInterval(tick, 60 * 1000);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handle(req, res, url);
  return staticFile(res, url.pathname);
}).listen(PORT, async () => {
  console.log(`\n  Radar de Preços rodando em  http://localhost:${PORT}`);
  console.log(`  Banco: ${(await dbKind()) === 'neon' ? 'Neon (DATABASE_URL)' : 'PGlite local (data/pglite)'}\n`);
  if (!emailConfigured()) console.log('  (e-mail ainda não configurado: veja o arquivo .env.example)\n');
});
