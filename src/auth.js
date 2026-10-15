// Login por link no e-mail (sem senha).
//   1. A pessoa informa o e-mail; se estiver cadastrada, recebe um link de uso único.
//   2. O link abre /api/entrar, que troca o token por um cookie de sessão assinado.
// Só quem foi convidado (cadastrado em users) consegue entrar.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { q, one, getUser } from './db.js';

export const COOKIE = 'radar_sessao';
const SESSION_DAYS = 90;
export const LOGIN_TTL_MIN = 30; // link pedido na tela de login
export const INVITE_TTL_DAYS = 7; // link do convite
const MAX_LINKS_PER_HOUR = 5;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Segredo das sessões: SESSION_SECRET, ou um gerado uma vez e guardado no banco
// (assim não é preciso criar mais uma variável na Vercel).
let secretCache = null;
async function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (secretCache) return secretCache;
  await q(`INSERT INTO kv (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING`, [randomBytes(32).toString('hex')]);
  secretCache = (await one(`SELECT value FROM kv WHERE key = 'session_secret'`)).value;
  return secretCache;
}

const sign = async (value) => createHmac('sha256', await secret()).update(value).digest('hex');

export async function sessionCookie(userId, secure) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const value = `${userId}.${exp}.${await sign(`${userId}.${exp}`)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export const clearCookie = (secure) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

/** Pessoa logada (ou null). */
export async function currentUser(req) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [uid, exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!uid || !exp || !sig || Number(exp) < Date.now()) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(await sign(`${uid}.${exp}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return getUser(Number(uid)); // null se a pessoa foi removida
}

/** Cria um link de acesso. Retorna o token (só existe aqui; o banco guarda o hash) ou null se passou do limite. */
export async function createLoginToken(userId, ttlMs) {
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const { n } = await one('SELECT COUNT(*)::int AS n FROM login_tokens WHERE user_id = $1 AND created_at >= $2', [userId, hourAgo]);
  if (n >= MAX_LINKS_PER_HOUR) return null;
  // Limpa links vencidos de todo mundo, para a tabela não crescer.
  await q('DELETE FROM login_tokens WHERE expires_at < $1', [new Date(Date.now() - 864e5).toISOString()]);
  const token = randomBytes(32).toString('base64url');
  await q('INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(token),
    userId,
    new Date().toISOString(),
    new Date(Date.now() + ttlMs).toISOString(),
  ]);
  return token;
}

/** Troca o token por um usuário. Uso único: o UPDATE ... RETURNING garante que só uma chamada vence. */
export async function consumeLoginToken(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const now = new Date().toISOString();
  const row = await one(
    `UPDATE login_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id`,
    [sha256(token), now],
  );
  if (!row) return null;
  await q('UPDATE users SET last_login = $2 WHERE id = $1', [row.user_id, now]);
  return getUser(row.user_id);
}
