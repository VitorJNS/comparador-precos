// Radar de Preços — painel (sem framework; rotas por hash).

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const tooltip = $('#tooltip');

const state = {
  region: readPref('regiao', 'todas'),
  overview: null,
  allCandidates: false,
  chartAsTable: false,
  polling: null,
};

// ---------- utilidades ----------

function readPref(k, fallback) {
  try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
}
function writePref(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

const brl = (n) => (n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const brlParts = (n) => {
  const s = n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<small>R$</small>${s}`;
};
const pct = (n) => `${n > 0 ? '+' : ''}${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function timeAgo(iso) {
  if (!iso) return 'nunca';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'agora mesmo';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}
const fmtDate = (iso, withTime = true) =>
  new Date(iso).toLocaleString('pt-BR', withTime ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const marketColor = (id) => `var(--m-${id})`;

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`/api/${path}${opts.method && opts.method !== 'GET' ? '' : `${sep}regiao=${state.region}`}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'login') {
    showLogin();
    throw new Error('Faça login para continuar');
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// ---------- login (quando o painel está protegido por PAINEL_SENHA) ----------

function showLogin() {
  const dlg = $('#loginDialog');
  if (dlg.open) return;
  $('#loginError').textContent = '';
  dlg.showModal();
  $('#loginForm').senha.focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const senha = e.currentTarget.senha.value;
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha }) });
  if (!res.ok) {
    $('#loginError').textContent = 'Senha incorreta';
    return;
  }
  $('#loginDialog').close();
  e.currentTarget.reset();
  route();
});

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const ICON = {
  bottle: '<svg viewBox="0 0 24 24"><path d="M10 2h4v4l2 3v12a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9l2-3z"/><path d="M8 13h8"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
  store: '<svg viewBox="0 0 24 24"><path d="M4 10v10h16V10M3 10l2-6h14l2 6zM9 20v-6h6v6"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z"/></svg>',
};

const EVENT = {
  minimo: { cls: 'ev-good', icon: ICON.star, label: 'Menor preço já registrado' },
  queda: { cls: 'ev-good', icon: ICON.down, label: 'Preço caiu' },
  promocao: { cls: 'ev-info', icon: ICON.tag, label: 'Entrou em promoção' },
  voltou: { cls: 'ev-info', icon: ICON.back, label: 'Voltou ao estoque' },
  aumento: { cls: 'ev-bad', icon: ICON.up, label: 'Preço subiu' },
};

function statusBadge(status) {
  const map = {
    ok: ['st-ok', ICON.check, 'Funcionando'],
    parcial: ['st-warn', ICON.alert, 'Parcial'],
    erro: ['st-err', ICON.x, 'Com erro'],
    pendente: ['st-idle', ICON.minus, 'Aguardando'],
  };
  const [cls, icon, label] = map[status] ?? map.pendente;
  return `<span class="status ${cls}"><span class="status-icon">${icon}</span>${label}</span>`;
}

function thumb(src) {
  return `<div class="thumb">${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(document.createRange().createContextualFragment('${ICON.bottle.replace(/"/g, '&quot;')}'))">` : ICON.bottle}</div>`;
}

// ---------- tooltip ----------

function showTooltip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}
const hideTooltip = () => (tooltip.hidden = true);

// ---------- gráficos ----------

function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= Math.max(1, min * 0.05);
    max += Math.max(1, max * 0.05);
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function sparkline(points) {
  if (points.length < 2) {
    return `<div class="muted" style="font-size:12px;padding-top:14px">O histórico aparece a partir da 2ª coleta.</div>`;
  }
  const w = 260, h = 44, pad = 4;
  const xs = points.map((p) => new Date(p.at).getTime());
  const ys = points.map((p) => p.min);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const X = (v) => pad + ((v - x0) / (x1 - x0 || 1)) * (w - pad * 2);
  const Y = (v) => pad + (1 - (v - y0) / (y1 - y0)) * (h - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(p.min).toFixed(1)}`).join('');
  const last = points.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px" role="img"
    aria-label="Menor preço ao longo do tempo: de ${brl(points[0].min)} para ${brl(last.min)}">
    <path class="area" d="${d}L${X(x1)},${h}L${X(x0)},${h}Z"/>
    <path class="line" d="${d}" vector-effect="non-scaling-stroke"/>
    <path class="end" d="M${X(xs.at(-1))},${Y(last.min)}h0" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

// Gráfico de linhas: menor preço de cada mercado a cada coleta.
function lineChart(container, history, markets) {
  const series = markets
    .map((m) => ({ ...m, pts: history.filter((h) => h.prices[m.id] != null).map((h) => ({ t: new Date(h.at).getTime(), v: h.prices[m.id], at: h.at })) }))
    .filter((s) => s.pts.length);

  if (!series.length) {
    container.innerHTML = `<div class="empty">${ICON.pulse}<div>Ainda não há preços disponíveis nesta região.</div></div>`;
    return;
  }

  const draw = () => {
    const W = container.clientWidth || 600;
    const H = 260;
    const m = { t: 12, r: series.length <= 4 ? 110 : 16, b: 28, l: 72 };
    const all = series.flatMap((s) => s.pts);
    const times = [...new Set(history.map((h) => new Date(h.at).getTime()))].sort((a, b) => a - b);
    const tMin = Math.min(...times), tMax = Math.max(...times);
    const ticks = niceTicks(Math.min(...all.map((p) => p.v)), Math.max(...all.map((p) => p.v)));
    const yMin = ticks[0], yMax = ticks.at(-1);
    const X = (t) => (times.length === 1 ? m.l + (W - m.l - m.r) / 2 : m.l + ((t - tMin) / (tMax - tMin)) * (W - m.l - m.r));
    const Y = (v) => m.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - m.t - m.b);

    const xTickCount = Math.min(times.length, Math.max(2, Math.floor((W - m.l - m.r) / 110)));
    const xTicks = times.length === 1 ? times : Array.from({ length: xTickCount }, (_, i) => tMin + ((tMax - tMin) * i) / (xTickCount - 1));
    const sameDay = tMax - tMin < 864e5 * 1.5;

    const showMarkers = times.length <= 30;
    const paths = series
      .map((s) => {
        const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
        const dots = showMarkers || s.pts.length === 1
          ? s.pts.map((p) => `<circle cx="${X(p.t)}" cy="${Y(p.v)}" r="4" fill="${marketColor(s.id)}"/>`).join('')
          : '';
        return `<g class="series"><path d="${d}" stroke="${marketColor(s.id)}"/>${dots}</g>`;
      })
      .join('');

    // Rótulos diretos no fim das linhas (até 4 séries), afastados para não colidir.
    let labels = '';
    if (series.length <= 4) {
      const ends = series.map((s) => ({ s, y: Y(s.pts.at(-1).v), x: X(s.pts.at(-1).t) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
      labels = ends
        .map((e) => `<text class="end-label" x="${e.x + 10}" y="${e.y + 4}">${esc(e.s.name)}</text>`)
        .join('');
    }

    container.innerHTML = `
      <svg class="chart-svg" width="${W}" height="${H}" role="img" aria-label="Histórico do menor preço por mercado">
        <g class="grid">${ticks.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/>`).join('')}</g>
        <line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>
        <g class="axis">
          ${ticks.map((t) => `<text x="${m.l - 10}" y="${Y(t) + 4}" text-anchor="end">${brl(t).replace(',00', '')}</text>`).join('')}
          ${xTicks.map((t) => `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${sameDay ? fmtTime(new Date(t).toISOString()) : fmtDate(new Date(t).toISOString(), false)}</text>`).join('')}
        </g>
        ${paths}
        ${labels}
        <line class="crosshair" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
        <rect class="hit" x="${m.l}" y="${m.t}" width="${Math.max(1, W - m.l - m.r)}" height="${H - m.t - m.b}" fill="transparent"/>
      </svg>`;

    const svg = container.querySelector('svg');
    const cross = svg.querySelector('.crosshair');
    const hit = svg.querySelector('.hit');
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const t = times.reduce((best, cur) => (Math.abs(X(cur) - px) < Math.abs(X(best) - px) ? cur : best), times[0]);
      cross.setAttribute('x1', X(t));
      cross.setAttribute('x2', X(t));
      cross.setAttribute('visibility', 'visible');
      const rows = series
        .map((s) => ({ s, p: s.pts.find((p) => p.t === t) }))
        .filter((r) => r.p)
        .sort((a, b) => a.p.v - b.p.v)
        .map((r) => `<div class="tt-row"><span><i style="background:${marketColor(r.s.id)}"></i>${esc(r.s.name)}</span><strong>${brl(r.p.v)}</strong></div>`)
        .join('');
      showTooltip(`<div class="tt-date">${fmtDate(new Date(t).toISOString())}</div>${rows || '<div class="muted">Sem preço disponível</div>'}`, ev.clientX, ev.clientY);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTooltip(); });
  };

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
  container._ro?.disconnect();
  container._ro = ro;
}

function historyTable(history, markets) {
  const used = markets.filter((m) => history.some((h) => h.prices[m.id] != null));
  if (!used.length) return `<div class="empty">Sem dados nesta região.</div>`;
  return `<div class="table-wrap"><table class="rank"><thead><tr><th>Coleta</th>${used.map((m) => `<th>${esc(m.name)}</th>`).join('')}</tr></thead>
    <tbody>${[...history].reverse().map((h) => `<tr><td class="num">${fmtDate(h.at)}</td>${used.map((m) => `<td class="num">${brl(h.prices[m.id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- topo / região / progresso ----------

function renderRegions(regions) {
  const el = $('#regions');
  const opts = [{ id: 'todas', name: 'Todas' }, ...regions];
  el.innerHTML = opts
    .map((r) => `<button class="seg" role="radio" aria-checked="${r.id === state.region}" data-region="${r.id}">${esc(r.name)}</button>`)
    .join('');
}

$('#regions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-region]');
  if (!b || b.dataset.region === state.region) return;
  state.region = b.dataset.region;
  writePref('regiao', state.region);
  document.querySelectorAll('#regions .seg').forEach((s) => s.setAttribute('aria-checked', s.dataset.region === state.region));
  app.classList.add('loading');
  route();
});

function renderStatus(o) {
  const last = o.runs.last;
  const email = o.email.configured
    ? `<span title="Alertas para ${esc(o.email.to)}">${ICON.mail}</span>`
    : `<span title="E-mail não configurado" style="color:var(--critical-text)">${ICON.mail}</span>`;
  $('#status').innerHTML = o.progress.running
    ? `<span class="status st-warn"><span class="status-icon">${ICON.pulse}</span>Coletando preços…</span>`
    : `${email}<span>Atualizado ${timeAgo(last?.finished_at)}</span><span class="muted">·</span><span class="muted">próxima às ${fmtTime(o.runs.next)}</span>`;
}

function renderProgress(p) {
  const box = $('#progress');
  const btn = $('#runBtn');
  box.hidden = !p.running;
  btn.disabled = p.running;
  btn.classList.toggle('spinning', p.running);
  if (!p.running) return;
  const ratio = p.total ? p.done / p.total : 0;
  $('#progressFill').style.width = `${Math.max(4, ratio * 100)}%`;
  $('#progressText').textContent = `${p.done}/${p.total} · ${p.log.at(-1)?.replace(/^\[[^\]]+\]\s*/, '') ?? 'iniciando…'}`;
}

function startPolling() {
  if (state.polling) return;
  state.polling = setInterval(async () => {
    const p = await api('progress').catch(() => null);
    if (!p) return;
    renderProgress(p);
    if (!p.running) {
      clearInterval(state.polling);
      state.polling = null;
      toast('Coleta concluída');
      route();
    }
  }, 1500);
}

$('#runBtn').addEventListener('click', async () => {
  try {
    const r = await api('run', { method: 'POST' });
    toast(r.started ? 'Coleta iniciada — leva alguns minutos' : 'Já existe uma coleta em andamento');
    renderProgress({ running: true, done: 0, total: 1, current: {}, log: [] });
    startPolling();
  } catch (e) {
    toast(e.message);
  }
});

$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  writePref('tema', root.dataset.theme);
});

// ---------- visão geral ----------

function kpis(o) {
  const active = o.products.filter((p) => p.active).length;
  const okMarkets = o.runs.markets.filter((m) => m.status === 'ok').length;
  const withOffer = o.products.filter((p) => p.best?.available).length;
  return `<div class="kpis">
    <div class="panel kpi"><div class="kpi-label">${ICON.box}Produtos monitorados</div><div class="kpi-value num">${active}</div><div class="kpi-foot">${withOffer} com oferta disponível</div></div>
    <div class="panel kpi"><div class="kpi-label">${ICON.tag}Promoções ativas</div><div class="kpi-value num">${o.stats.promos}</div><div class="kpi-foot">preço "de/por" nesta região</div></div>
    <div class="panel kpi"><div class="kpi-label">${ICON.down}Quedas em 7 dias</div><div class="kpi-value num">${o.stats.drops7d}</div><div class="kpi-foot">inclui novos menores preços</div></div>
    <div class="panel kpi"><div class="kpi-label">${ICON.store}Lojas funcionando</div><div class="kpi-value num">${okMarkets}<span class="muted" style="font-size:18px">/${o.runs.markets.length}</span></div><div class="kpi-foot">${o.runs.unsupported.length} sem loja online</div></div>
  </div>`;
}

// Botão que abre, no site do mercado, a oferta mais barata disponível.
function buyButton(g, cls = 'btn-primary btn-sm') {
  if (!g?.available || !g.url) return '';
  return `<a class="btn ${cls} buy" href="${esc(g.url)}" target="_blank" rel="noopener" title="Abrir a oferta no site do ${esc(g.marketName)}">Abrir no ${esc(g.marketName)}${ICON.ext}</a>`;
}

function productCard(p) {
  const b = p.best;
  const sub = [p.marketsWithOffer ? `${p.marketsWithOffer} mercado${p.marketsWithOffer > 1 ? 's' : ''}` : null, p.storeCount ? `${p.storeCount} loja${p.storeCount > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
  let body;
  if (!b) {
    body = `<div class="card-empty">Nenhuma oferta disponível ${state.region === 'todas' ? 'no momento' : 'nesta região'}. Você recebe um e-mail quando aparecer em estoque.</div>`;
  } else {
    const atMin = b.available && p.historicMin != null && b.price <= p.historicMin + 0.005;
    const where = b.stores.length > 1 ? `${b.stores.length} lojas` : b.stores[0].name;
    body = `
      <div class="card-price">
        <div class="price-hero num">${brlParts(b.price)}</div>
        <div class="price-where">
          <span class="market-tag"><span class="dot" style="background:${marketColor(b.market)}"></span>${esc(b.marketName)}</span>
          <span class="muted">· ${esc(where)}</span>
        </div>
        <div class="card-item" title="${esc(b.title)}">${esc(b.title)}</div>
        <div class="card-chips">
          ${b.promo ? `<span class="badge badge-promo">${ICON.tag}-${b.discountPct}% (de ${brl(b.listPrice)})</span>` : ''}
          ${atMin && p.spark.length > 1 ? `<span class="badge badge-good">${ICON.star}Menor preço já visto</span>` : ''}
        </div>
      </div>
      <div class="card-spark">${sparkline(p.spark)}</div>`;
  }
  return `<div class="card ${p.active ? '' : 'inactive'} fade-in" data-href="#/produto/${p.id}" role="link" tabindex="0" aria-label="Ver ranking de ${esc(p.name)}">
    <div class="card-top">
      ${thumb(b?.image ?? p.image)}
      <div style="min-width:0">
        <div class="card-title" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="card-sub">${p.active ? 'Monitorando' : 'Pausado'}${b ? ` · visto ${timeAgo(b.seenAt)}` : ''}</div>
      </div>
    </div>
    ${body}
    <div class="card-foot"><span>${sub || 'sem ofertas'}</span>${buyButton(b) || '<span>Ver ranking →</span>'}</div>
  </div>`;
}

function eventItem(e, withProduct = true) {
  const meta = EVENT[e.type] ?? EVENT.queda;
  const ref = e.type === 'promocao' ? e.list_price : e.old_price;
  const change = ref && e.new_price && ref !== e.new_price ? (e.new_price / ref - 1) * 100 : null;
  return `<li>
    <div class="ev-icon ${meta.cls}" aria-hidden="true">${meta.icon}</div>
    <div style="min-width:0">
      <div class="ev-title">${meta.label}${change && e.type !== 'voltou' ? ` <span class="muted" style="font-weight:500">${pct(change)}</span>` : ''}</div>
      <div class="ev-sub">${withProduct ? `${esc(e.product_name)} · ` : ''}${esc(e.store_name ?? e.marketName)} · ${timeAgo(e.created_at)}</div>
    </div>
    <div class="ev-price num">${ref && ref !== e.new_price ? `<s>${brl(ref)}</s>` : ''}${brl(e.new_price)}</div>
  </li>`;
}

function healthList(o) {
  const row = (m) => `<li title="${esc(m.error ?? '')}">
      <span class="h-name"><span class="dot" style="background:${marketColor(m.id)}"></span>${esc(m.name)}</span>
      <span style="display:flex;gap:12px;align-items:center"><span class="h-meta">${m.offers} ofertas</span>${statusBadge(m.status)}</span>
    </li>`;
  const group = (kind) => o.runs.markets.filter((m) => m.kind === kind).map(row).join('');
  const unsup = o.runs.unsupported
    .map((m) => `<li class="unsupported" title="${esc(m.reason)}"><span class="h-name"><span class="dot" style="background:var(--axis)"></span>${esc(m.name)}</span><span class="h-meta">${esc(m.reason)}</span></li>`)
    .join('');
  return `<div class="health-group">Supermercados</div><ul class="health">${group('mercado')}</ul>
    <div class="health-group">Varejo · só produtos marcados</div><ul class="health">${group('varejo')}</ul>
    <div class="health-sep"></div><ul class="health">${unsup}</ul>`;
}

function settingsPanel(o) {
  return `<div class="panel settings-grid">
    <div>
      <h3>Alertas por e-mail</h3>
      ${o.email.configured
        ? `<p>${statusBadge('ok')}</p><p class="muted" style="font-size:13px">Enviando para <strong style="color:var(--text)">${esc(o.email.to)}</strong> quando houver queda, promoção, volta ao estoque ou novo menor preço.</p>
           <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="testEmail">${ICON.mail}Enviar resumo agora</button><a class="btn btn-ghost btn-sm" href="/api/email-preview" target="_blank">Pré-visualizar</a></div>`
        : `<p>${statusBadge('erro').replace('Com erro', 'Não configurado')}</p><p class="muted" style="font-size:13px">Copie <code>.env.example</code> para <code>.env</code>, coloque uma senha de app do Gmail em <code>SMTP_PASS</code> e reinicie o app.</p><a class="btn btn-ghost btn-sm" href="/api/email-preview" target="_blank">Pré-visualizar e-mail</a>`}
    </div>
    <div>
      <h3>Agendamento</h3>
      <p>${o.runs.hosted ? 'Uma vez por dia, por volta das <strong>06:00</strong> (Vercel).' : `A cada <strong>${o.runs.intervalHours} horas</strong> enquanto o app estiver aberto.`}</p>
      <p class="muted" style="font-size:13px">Última coleta: ${o.runs.last ? fmtDate(o.runs.last.started_at) : '—'}<br>Próxima: ${fmtDate(o.runs.next)}</p>
      <p class="muted" style="font-size:12px">${o.runs.hosted ? 'Ajuste o horário em <code>vercel.json</code>.' : 'Ajuste em <code>config/settings.json</code>.'}</p>
      ${o.runs.hosted ? '<button class="btn btn-ghost btn-sm" id="logoutBtn" style="margin-top:6px">Sair do painel</button>' : ''}
    </div>
    <div>
      <h3>CEPs pesquisados</h3>
      <ul class="cep-list">${o.regions.map((r) => `<li><strong style="color:var(--text)">${esc(r.name)}</strong>: ${r.ceps.map((c) => esc(c.cidade)).join(', ')}</li>`).join('')}</ul>
    </div>
  </div>`;
}

async function renderHome() {
  const o = await api('overview');
  state.overview = o;
  renderRegions(o.regions);
  renderStatus(o);
  renderProgress(o.progress);
  if (o.progress.running) startPolling();

  // A lista mostra só produtos com oferta disponível. Os demais seguem monitorados
  // e voltam para a lista sozinhos quando aparecer oferta.
  const sorted = [...o.products].sort((a, b) => b.active - a.active || a.id - b.id);
  const products = sorted.filter((p) => p.best);
  const waiting = sorted.filter((p) => !p.best);
  const waitingList = waiting.length
    ? `<details class="waiting">
        <summary>${waiting.length} produto${waiting.length > 1 ? 's' : ''} monitorado${waiting.length > 1 ? 's' : ''} sem oferta disponível ${state.region === 'todas' ? 'no momento' : 'nesta região'}</summary>
        <ul>${waiting.map((p) => `<li><a href="#/produto/${p.id}">${esc(p.name)}</a></li>`).join('')}</ul>
      </details>`
    : '';
  app.innerHTML = `
    <div class="fade-in">${kpis(o)}</div>
    <section class="section">
      <div class="section-head"><h2>Seus produtos</h2><span class="sub">Melhor preço ${state.region === 'todas' ? 'em todas as regiões' : `em ${esc(o.regions.find((r) => r.id === state.region)?.name)}`}</span></div>
      <div class="cards">${products.map(productCard).join('') || `<div class="panel empty">${o.products.length ? 'Nenhum produto com oferta disponível agora.' : 'Nenhum produto. Clique em "Produto" para adicionar.'}</div>`}</div>
      ${waitingList}
    </section>
    <section class="section grid-2">
      <div>
        <div class="section-head"><h2>Alertas recentes</h2><span class="sub">quedas, promoções e estoque</span></div>
        <div class="panel">${o.events.length ? `<ul class="feed">${o.events.map((e) => eventItem(e)).join('')}</ul>` : `<div class="empty">${ICON.inbox}<div>Nenhuma alteração ainda. As mudanças aparecem a partir da 2ª coleta.</div></div>`}</div>
      </div>
      <div>
        <div class="section-head"><h2>Lojas</h2><span class="sub">última coleta</span></div>
        <div class="panel">${healthList(o)}</div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Configurações</h2></div>
      ${settingsPanel(o)}
    </section>`;

  app.querySelectorAll('.card[data-href]').forEach((card) => {
    const go = (e) => {
      if (e.target.closest('.buy')) return;
      location.hash = card.dataset.href;
    };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) go(e); });
  });

  $('#logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    showLogin();
  });

  $('#testEmail')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api('email-teste', { method: 'POST' });
      toast('Resumo enviado — confira sua caixa de entrada');
    } catch (err) {
      toast(err.message);
    } finally {
      e.currentTarget.disabled = false;
    }
  });
}

// ---------- detalhe do produto ----------

function rankingRows(ranking) {
  if (!ranking.length) return `<tr><td colspan="5"><div class="empty">Nenhuma oferta disponível ${state.region === 'todas' ? 'no momento' : 'nesta região'}.</div></td></tr>`;
  return ranking
    .map((g, i) => {
      const storeList = g.stores.length > 1
        ? `<details class="stores"><summary>${g.stores.length} lojas com este preço</summary><ul>${g.stores.map((s) => `<li>${esc(s.name)}</li>`).join('')}</ul></details>`
        : `<div class="store-name">${esc(g.stores[0].name)}</div>`;
      const note = g.stores.find((s) => s.note)?.note;
      return `<tr>
        <td class="pos ${i === 0 ? 'first' : ''}">${i + 1}º</td>
        <td>
          <div class="market-tag"><span class="dot" style="background:${marketColor(g.market)}"></span>${esc(g.marketName)}</div>
          ${storeList}
          ${note ? `<div class="store-note">${esc(note)}</div>` : ''}
        </td>
        <td class="hide-sm" style="max-width:280px"><div style="font-size:13px">${esc(g.title)}</div>${g.voltages?.length ? `<div class="store-note">${g.voltages.join(' e ')}</div>` : ''}</td>
        <td class="price-cell num">${g.listPrice && g.listPrice > g.price ? `<span class="list">${brl(g.listPrice)}</span>` : ''}${brl(g.price)}
          ${g.promo ? `<div><span class="badge badge-promo">-${g.discountPct}%</span></div>` : ''}</td>
        <td><div class="row-actions">
          ${g.url ? `<a class="btn btn-ghost btn-sm" href="${esc(g.url)}" target="_blank" rel="noopener" title="Abrir no site">${ICON.ext}</a>` : ''}
          <button class="btn btn-ghost btn-sm" data-reject="${esc((g.extKeys?.length ? g.extKeys : [g.stores[0].extKey ?? g.stores[0].id]).join(','))}" data-title="${esc(g.title)}" title="Não é este produto">${ICON.x}</button>
        </div></td>
      </tr>`;
    })
    .join('');
}

async function renderProduct(id) {
  const [d, o] = await Promise.all([api(`products/${id}`), state.overview ? Promise.resolve(state.overview) : api('overview')]);
  state.overview = o;
  renderRegions(o.regions);
  renderStatus(o);
  renderProgress(o.progress);

  const p = d.product;
  const best = d.ranking[0];
  const worst = d.ranking.at(-1);

  app.innerHTML = `
    <div class="fade-in">
      <a class="back" href="#/">${ICON.left}Todos os produtos</a>
      <div class="detail-head">
        <div style="display:flex;gap:16px;align-items:center;min-width:0">
          ${thumb(d.ranking[0]?.image ?? p.image)}
          <div style="min-width:0">
            <h1>${esc(p.name)}</h1>
            <div class="chips">
              <span class="chip">busca: “${esc(p.query)}”</span>
              ${p.include.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
              ${p.exclude.map((t) => `<span class="chip chip-no" title="termo proibido">${esc(t)}</span>`).join('')}
              ${p.eans.map((t) => `<span class="chip">EAN ${esc(t)}</span>`).join('')}
              ${p.maxPrice ? `<span class="chip">até ${brl(p.maxPrice)}</span>` : ''}
              <span class="chip">${p.channels === 'todos' ? 'mercados + varejo' : 'só mercados'}</span>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="editBtn">${ICON.edit}<span>Editar</span></button>
          <button class="btn btn-ghost btn-danger" id="delBtn">${ICON.trash}<span>Excluir</span></button>
        </div>
      </div>

      <div class="hero-row">
        <div class="panel hero-card">
          <div class="kpi-label">Melhor preço agora</div>
          ${best
            ? `<div class="price-hero num" style="margin-top:6px">${brlParts(best.price)}</div>
               <div class="price-where"><span class="market-tag"><span class="dot" style="background:${marketColor(best.market)}"></span>${esc(best.marketName)}</span><span class="muted">· ${esc(best.stores.length > 1 ? `${best.stores.length} lojas` : best.stores[0].name)}</span></div>
               <div style="margin-top:12px">${buyButton(best, 'btn-primary')}</div>`
            : `<div class="kpi-value muted">—</div><div class="kpi-foot">nenhuma oferta disponível</div>`}
        </div>
        <div class="panel hero-card">
          <div class="kpi-label">Diferença entre o mais barato e o mais caro</div>
          ${best && worst && worst.price > best.price
            ? `<div class="kpi-value num" style="margin-top:6px">${brl(worst.price - best.price)}</div><div class="kpi-foot">${Math.round((1 - best.price / worst.price) * 100)}% de economia vs ${esc(worst.marketName)}</div>`
            : `<div class="kpi-value muted" style="margin-top:6px">—</div><div class="kpi-foot">precisa de 2 preços diferentes</div>`}
        </div>
        <div class="panel hero-card">
          <div class="kpi-label">Menor preço já registrado</div>
          <div class="kpi-value num" style="margin-top:6px">${brl(d.historicMin)}</div>
          <div class="kpi-foot">${best && d.historicMin != null ? (best.price <= d.historicMin + 0.005 ? 'o preço atual é o menor já visto' : `atual está ${pct((best.price / d.historicMin - 1) * 100)} acima`) : 'considera todas as regiões'}</div>
        </div>
      </div>

      <section class="section panel">
        <div class="toolbar">
          <h2>Ranking de preços</h2>
          <span class="muted" style="font-size:13px">só ofertas disponíveis</span>
        </div>
        <div class="table-wrap"><table class="rank">
          <thead><tr><th>#</th><th>Mercado / loja</th><th class="hide-sm">Item no site</th><th>Preço</th><th></th></tr></thead>
          <tbody>${rankingRows(d.ranking)}</tbody>
        </table></div>
      </section>

      <section class="section panel">
        <div class="toolbar">
          <h2>Histórico do menor preço por mercado</h2>
          <button class="toggle-link" id="toggleChart">${state.chartAsTable ? 'Ver gráfico' : 'Ver como tabela'}</button>
        </div>
        <div class="legend">${d.markets.filter((m) => d.history.some((h) => h.prices[m.id] != null)).map((m) => `<span><i style="background:${marketColor(m.id)}"></i>${esc(m.name)}</span>`).join('')}</div>
        <div class="chart-box" id="chart"></div>
      </section>

      <section class="section grid-2">
        <div>
          <div class="section-head"><h2>Itens descartados</h2><span class="sub">encontrados na busca, mas fora dos seus termos</span></div>
          <div class="panel">${d.candidates.length
            ? (state.allCandidates ? d.candidates : d.candidates.slice(0, 5)).map((c) => `<div class="cand">
                ${thumb(c.image)}
                <div style="min-width:0"><div class="cand-title">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</div>
                  <div class="cand-reason"><span class="market-tag" style="font-weight:500;color:var(--text-2)"><span class="dot" style="background:${marketColor(c.market)}"></span>${esc(d.markets.find((m) => m.id === c.market)?.name ?? c.market)}</span> · ${esc(c.reason)}${c.price ? ` · ${brl(c.price)}` : ''}</div></div>
                <button class="btn btn-secondary btn-sm" data-accept="${esc(c.ext_key)}">${ICON.check}<span>É este</span></button>
              </div>`).join('') + (d.candidates.length > 5 ? `<button class="toggle-link more" id="toggleCand">${state.allCandidates ? 'Mostrar menos' : `Mostrar todos os ${d.candidates.length}`}</button>` : '')
            : `<div class="empty">Nada descartado na última coleta.</div>`}</div>
        </div>
        <div>
          <div class="section-head"><h2>Alterações deste produto</h2></div>
          <div class="panel">${d.events.length ? `<ul class="feed">${d.events.map((e) => eventItem(e, false)).join('')}</ul>` : `<div class="empty">${ICON.inbox}<div>Sem alterações registradas.</div></div>`}</div>
        </div>
      </section>
    </div>`;

  const chartEl = $('#chart');
  if (state.chartAsTable) chartEl.innerHTML = historyTable(d.history, d.markets);
  else lineChart(chartEl, d.history, d.markets);

  $('#toggleChart').onclick = () => { state.chartAsTable = !state.chartAsTable; renderProduct(id); };
  $('#toggleCand')?.addEventListener('click', () => { state.allCandidates = !state.allCandidates; renderProduct(id); });
  $('#editBtn').onclick = () => openProductDialog(p);
  $('#delBtn').onclick = async () => {
    if (!confirm(`Excluir "${p.name}" e todo o histórico de preços dele?`)) return;
    await api(`products/${id}`, { method: 'DELETE' });
    toast('Produto excluído');
    location.hash = '#/';
  };

  app.querySelectorAll('[data-accept]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`products/${id}/aceitar`, { method: 'POST', body: { key: b.dataset.accept } });
      toast('Anotado! O item entra no ranking na próxima coleta.');
      renderProduct(id);
    }),
  );
  app.querySelectorAll('[data-reject]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`Descartar "${b.dataset.title}" deste produto? Ele não será mais comparado.`)) return;
      await api(`products/${id}/descartar`, { method: 'POST', body: { keys: b.dataset.reject.split(',') } });
      toast('Item descartado');
      renderProduct(id);
    }),
  );
}

// ---------- formulário de produto ----------

const dialog = $('#productDialog');
const form = $('#productForm');
let editing = null;

function openProductDialog(p = null) {
  editing = p;
  $('#dialogTitle').textContent = p ? 'Editar produto' : 'Novo produto';
  $('#formError').textContent = '';
  form.name.value = p?.name ?? '';
  form.query.value = p?.query ?? '';
  form.include.value = (p?.include ?? []).join(', ');
  form.exclude.value = (p?.exclude ?? ['kit', 'miniatura']).join(', ');
  form.eans.value = (p?.eans ?? []).join(', ');
  form.channels.value = p?.channels ?? 'mercados';
  form.maxPrice.value = p?.maxPrice ? p.maxPrice.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
  form.active.checked = p?.active ?? true;
  dialog.showModal();
  form.name.focus();
}

$('#addBtn').addEventListener('click', () => openProductDialog());
dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: form.name.value.trim(),
    query: form.query.value.trim() || form.name.value.trim(),
    include: form.include.value,
    exclude: form.exclude.value,
    eans: form.eans.value,
    maxPrice: form.maxPrice.value,
    channels: form.channels.value,
    active: form.active.checked,
  };
  if (!form.include.value.trim()) body.include = body.query.split(/\s+/).filter((w) => w.length > 1).join(',');
  try {
    $('#saveBtn').disabled = true;
    if (editing) await api(`products/${editing.id}`, { method: 'PUT', body });
    else {
      const r = await api('products', { method: 'POST', body });
      location.hash = `#/produto/${r.id}`;
    }
    dialog.close();
    toast(editing ? 'Produto atualizado — vale rodar "Atualizar agora"' : 'Produto criado — clique em "Atualizar agora" para buscar preços');
    route();
  } catch (err) {
    $('#formError').textContent = err.message;
  } finally {
    $('#saveBtn').disabled = false;
  }
});

// ---------- roteamento ----------

async function route() {
  hideTooltip();
  const m = location.hash.match(/^#\/produto\/(\d+)/);
  try {
    if (m) await renderProduct(Number(m[1]));
    else await renderHome();
  } catch (err) {
    app.innerHTML = `<div class="panel empty">Não foi possível carregar: ${esc(err.message)}</div>`;
  } finally {
    app.classList.remove('loading');
  }
}

addEventListener('hashchange', () => { scrollTo(0, 0); route(); });
setInterval(() => { if (!state.polling && !document.hidden && !location.hash.startsWith('#/produto')) route(); }, 5 * 60 * 1000);
route();
