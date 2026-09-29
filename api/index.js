// Função da Vercel: recebe todas as rotas /api/* (ver "rewrites" no vercel.json).
import { handle } from '../src/app.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get('path');
  if (path !== null) {
    url.searchParams.delete('path');
    url.pathname = `/api/${path}`;
  }
  return handle(req, res, url);
}
