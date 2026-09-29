// Cliente HTTP educado: user-agent de navegador, timeout, retry e
// um intervalo mínimo entre requisições ao mesmo host (para não sobrecarregar os sites).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

let minGapMs = 600;
const lastHit = new Map(); // host -> timestamp da última requisição

export function setMinGap(ms) {
  minGapMs = ms;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle(host) {
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + minGapMs - Date.now();
  lastHit.set(host, Math.max(Date.now(), prev + minGapMs));
  if (wait > 0) await sleep(wait);
}

async function request(url, { method = 'GET', body, headers = {}, retries = 2, timeoutMs = 25000 } = {}) {
  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle(host);
    try {
      const res = await fetch(url, {
        method,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'pt-BR,pt;q=0.9',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} em ${host}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function getJson(url, opts) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts?.headers ?? {}) } });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    throw new Error(`Resposta não-JSON de ${new URL(url).host} (HTTP ${res.status})`);
  }
}

export async function postJson(url, body, opts) {
  return getJson(url, { ...opts, method: 'POST', body });
}

export async function getText(url, opts) {
  const res = await request(url, { ...opts, headers: { Accept: 'text/html', ...(opts?.headers ?? {}) } });
  return { status: res.status, text: await res.text() };
}
