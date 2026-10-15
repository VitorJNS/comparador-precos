// Radar de Preços — painel (sem framework; rotas por hash).

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const tooltip = $('#tooltip');

const state = {
  // Vazio = usa a região do perfil da pessoa (definida em "Sua conta").
  region: readPref('regiao', ''),
  cat: readPref('categoria', 'todos'),
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
  const withRegion = (!opts.method || opts.method === 'GET') && state.region;
  const res = await fetch(`/api/${path}${withRegion ? `${sep}regiao=${state.region}` : ''}`, {
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

// ---------- login por link no e-mail ----------

function loginStep(sent) {
  $('#loginBody').hidden = sent;
  $('#loginSent').hidden = !sent;
  $('#loginSubmit').hidden = sent;
  $('#loginBack').hidden = !sent;
  $('#loginError').textContent = '';
}

function showLogin() {
  const dlg = $('#loginDialog');
  if (dlg.open) return;
  app.innerHTML = '';
  loginStep(false);
  dlg.showModal();
  $('#loginForm').email.focus();
}

// Sem login não há o que fazer na tela: Esc não fecha o diálogo.
$('#loginDialog').addEventListener('cancel', (e) => e.preventDefault());
$('#loginBack').addEventListener('click', () => { loginStep(false); $('#loginForm').email.focus(); });

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.currentTarget.email.value.trim();
  $('#loginSubmit').disabled = true;
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('#loginError').textContent = data.error || `Erro ${res.status}`;
      return;
    }
    $('#loginSentTo').textContent = email;
    // Só no PC, sem e-mail configurado: o link aparece aqui em vez de ir por e-mail.
    $('#loginDev').hidden = !data.devLink;
    if (data.devLink) $('#loginDev').innerHTML = `E-mail não configurado neste PC. <a href="${esc(data.devLink)}">Entrar por aqui</a>.`;
    loginStep(true);
  } catch {
    $('#loginError').textContent = 'Sem conexão. Tente de novo.';
  } finally {
    $('#loginSubmit').disabled = false;
  }
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

// eager: carrega já (dentro de janelas com rolagem o "lazy" pode não disparar).
function thumb(src, eager = false) {
  return `<div class="thumb">${src ? `<img src="${esc(src)}" alt="" loading="${eager ? 'eager' : 'lazy'}" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createRange().createContextualFragment('${ICON.bottle.replace(/"/g, '&quot;')}'))">` : ICON.bottle}</div>`;
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

// Etiqueta quando o preço mostrado é o à vista no Pix (o do cartão está na observação da oferta).
const pixTag = (g) => (g?.stores?.some((st) => /no cart[aã]o/.test(st.note ?? '')) ? '<span class="pix-tag" title="Preço à vista no Pix. Parcelado, o valor é o do site.">no Pix</span>' : '');

// Links por voltagem só quando levam a páginas diferentes (na Samsung, a voltagem é escolhida na própria página).
function voltLinks(g) {
  const links = (g.links ?? []).filter((l) => l.voltage);
  return new Set(links.map((l) => l.url)).size > 1 ? links : [];
}

// Botão que abre, no site do mercado, a oferta mais barata disponível.
// Se a linha junta voltagens diferentes, um botão por voltagem (cada uma é um anúncio no site).
function buyButton(g, cls = 'btn-primary btn-sm') {
  if (!g?.available || !g.url) return '';
  const byVolt = voltLinks(g);
  if (byVolt.length > 1) {
    return `<span class="buy-volts">${byVolt.map((l) => `<a class="btn ${cls} buy" href="${esc(l.url)}" target="_blank" rel="noopener" title="Abrir a versão ${esc(l.voltage)} no site do ${esc(g.marketName)}">${esc(l.voltage)}${ICON.ext}</a>`).join('')}</span>`;
  }
  return `<a class="btn ${cls} buy" href="${esc(g.url)}" target="_blank" rel="noopener" title="Abrir a oferta no site do ${esc(g.marketName)}">Abrir no ${esc(g.marketName)}${ICON.ext}</a>`;
}

function delButton(p) {
  return `<button type="button" class="del-btn" data-del="${p.id}" title="Remover ${esc(p.name)}" aria-label="Remover ${esc(p.name)}">${ICON.trash}</button>`;
}

// Modal de confirmação (no lugar do confirm() do navegador). Resolve true se confirmar.
function confirmDialog({ title, message, ok = 'Confirmar' }) {
  const dlg = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmMsg').textContent = message;
  $('#confirmOk').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  $('#confirmOk').focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// Clicar fora do modal = cancelar.
$('#confirmDialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close('cancel');
});

async function removeProduct(p, after) {
  const ok = await confirmDialog({
    title: 'Remover produto?',
    message: `"${p.name}" sai da sua lista e você deixa de receber alertas dele. Se mais ninguém monitora, o histórico de preços é apagado.`,
    ok: 'Remover',
  });
  if (!ok) return;
  try {
    const r = await api(`products/${p.id}`, { method: 'DELETE' });
    toast(r.others ? 'Removido da sua lista (outras pessoas ainda monitoram)' : 'Produto removido');
    after?.();
  } catch (err) {
    toast(err.message);
  }
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
        <div class="price-hero num">${brlParts(b.price)}${pixTag(b)}</div>
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
      <div style="min-width:0;flex:1">
        <div class="card-title" title="${esc(p.name)}">${esc(p.name)}</div>
        <div class="card-sub">${p.active ? 'Monitorando' : 'Pausado'}${b ? ` · visto ${timeAgo(b.seenAt)}` : ''}</div>
      </div>
      ${delButton(p)}
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
      <span style="display:flex;gap:12px;align-items:center"><span class="h-meta">${m.offers} oferta${m.offers === 1 ? '' : 's'}</span>${statusBadge(m.status)}</span>
    </li>`;
  const group = (kind) => o.runs.markets.filter((m) => m.kind === kind).map(row).join('');
  const unsup = o.runs.unsupported
    .map((m) => `<li class="unsupported" title="${esc(m.reason)}"><span class="h-name"><span class="dot" style="background:var(--axis)"></span>${esc(m.name)}</span><span class="h-meta">${esc(m.reason)}</span></li>`)
    .join('');
  return `<div class="health-group">Supermercados</div><ul class="health">${group('mercado')}</ul>
    <div class="health-group">Varejo · só produtos marcados</div><ul class="health">${group('varejo')}</ul>
    <div class="health-sep"></div><ul class="health">${unsup}</ul>`;
}

function accountPanel(o) {
  const me = o.me;
  const regionOpts = [{ id: 'todas', name: 'Todas as regiões' }, ...o.regions]
    .map((r) => `<option value="${esc(r.id)}" ${r.id === me.region ? 'selected' : ''}>${esc(r.name)}</option>`)
    .join('');
  return `<div class="panel settings-grid">
    <div>
      <h3>Sua conta</h3>
      <p style="overflow-wrap:anywhere"><strong>${esc(me.name || me.email)}</strong>${me.name ? `<br><span class="muted" style="font-size:13px">${esc(me.email)}</span>` : ''}</p>
      <p class="muted" style="font-size:13px">${me.isAdmin ? 'Você administra o Radar e pode convidar pessoas.' : 'Você vê e recebe alertas só dos produtos da sua lista.'}</p>
      <button class="btn btn-ghost btn-sm" id="logoutBtn">Sair</button>
    </div>
    <form id="profileForm">
      <h3>Seu perfil</h3>
      <label class="field"><span class="field-label">Nome</span><input name="name" maxlength="60" value="${esc(me.name)}" placeholder="Como aparece nos convites" /></label>
      <label class="field"><span class="field-label">Sua região</span><select name="region">${regionOpts}</select>
        <span class="field-hint">Os e-mails só trazem lojas desta região. É também a região que o painel abre.</span></label>
      <button class="btn btn-secondary btn-sm" type="submit">Salvar perfil</button>
    </form>
  </div>`;
}

// Só para quem administra: convidar e remover pessoas.
function peoplePanel(o) {
  if (!o.users) return '';
  const row = (u) => `<li>
      <div style="min-width:0">
        <div class="person-name">${esc(u.name || u.email)}${u.isAdmin ? ' <span class="chip">administra</span>' : ''}</div>
        <div class="muted person-sub">${u.name ? `${esc(u.email)} · ` : ''}${u.products} produto${u.products === 1 ? '' : 's'} · ${u.lastLogin ? `entrou ${timeAgo(u.lastLogin)}` : 'ainda não entrou'}</div>
      </div>
      ${u.id === o.me.id ? '' : `<div class="row-actions">
        <button class="btn btn-ghost btn-sm" data-reinvite="${u.id}" title="Reenviar convite">${ICON.mail}</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-deluser="${u.id}" title="Remover ${esc(u.email)}">${ICON.trash}</button>
      </div>`}
    </li>`;
  return `<section class="section">
      <div class="section-head"><h2>Pessoas</h2><span class="sub">cada uma escolhe os próprios produtos e recebe os próprios alertas</span></div>
      <div class="panel settings-grid">
        <div><ul class="people">${o.users.map(row).join('')}</ul></div>
        <form id="inviteForm">
          <h3>Convidar alguém</h3>
          <label class="field"><span class="field-label">E-mail</span><input name="email" type="email" required placeholder="sogra@exemplo.com" /></label>
          <label class="field"><span class="field-label">Nome (opcional)</span><input name="name" maxlength="60" placeholder="Ex.: Dona Maria" /></label>
          <span class="form-error" id="inviteError" role="alert"></span>
          <button class="btn btn-primary btn-sm" type="submit">${ICON.mail}Enviar convite</button>
          <p class="field-hint" style="margin-top:8px">A pessoa recebe um link para entrar (vale 7 dias) e começa com a lista vazia.</p>
        </form>
      </div>
    </section>`;
}

function settingsPanel(o) {
  return `<div class="panel settings-grid">
    <div>
      <h3>Alertas por e-mail</h3>
      ${o.email.configured
        ? `<p>${statusBadge('ok')}</p><p class="muted" style="font-size:13px">Enviando para <strong style="color:var(--text)">${esc(o.email.to)}</strong> quando houver queda, promoção, volta ao estoque ou novo menor preço nos seus produtos.</p>
           <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="testEmail">${ICON.mail}Enviar resumo agora</button><a class="btn btn-ghost btn-sm" href="/api/email-preview" target="_blank">Pré-visualizar</a></div>`
        : `<p>${statusBadge('erro').replace('Com erro', 'Não configurado')}</p><p class="muted" style="font-size:13px">Copie <code>.env.example</code> para <code>.env</code>, coloque uma senha de app do Gmail em <code>SMTP_PASS</code> e reinicie o app.</p><a class="btn btn-ghost btn-sm" href="/api/email-preview" target="_blank">Pré-visualizar e-mail</a>`}
    </div>
    <div>
      <h3>Agendamento</h3>
      <p>${o.runs.hosted ? 'A cada <strong>6 horas</strong>: 00h, 06h, 12h e 18h (GitHub Actions).' : `A cada <strong>${o.runs.intervalHours} horas</strong> enquanto o app estiver aberto.`}</p>
      <p class="muted" style="font-size:13px">Última coleta: ${o.runs.last ? fmtDate(o.runs.last.started_at) : '—'}<br>Próxima: ${fmtDate(o.runs.next)}</p>
      <p class="muted" style="font-size:12px">${o.runs.hosted ? 'Ajuste em <code>.github/workflows/coleta-6h.yml</code>.' : 'Ajuste em <code>config/settings.json</code>.'}</p>
    </div>
    <div>
      <h3>CEPs pesquisados</h3>
      <ul class="cep-list">${o.regions.map((r) => `<li><strong style="color:var(--text)">${esc(r.name)}</strong>: ${r.ceps.map((c) => esc(c.cidade)).join(', ')}</li>`).join('')}</ul>
    </div>
  </div>`;
}

// ---------- categorias (abas da lista de produtos) ----------

const svgIcon = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
const CAT_ICON = {
  bebidas: svgIcon('<path d="M10 2h4v4l1.5 3v12a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V9L10 6z"/><path d="M8.5 13h7"/>'),
  eletro: svgIcon('<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 9h14M8 5v2M8 12v4"/>'),
  eletronicos: svgIcon('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  casa: svgIcon('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>'),
  limpeza: svgIcon('<path d="M9 3h6v4l2 3v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V10l2-3z"/><path d="M15 5h3"/><path d="M9 13h6"/>'),
  outros: svgIcon('<circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/>'),
};

// Só aparecem as categorias que têm produto com oferta; a aba escolhida fica salva no navegador.
function catTabs(categories, products) {
  const counts = new Map(categories.map((c) => [c.id, products.filter((p) => p.category === c.id).length]));
  const tab = (id, name, n) => '<button type="button" class="cat-tab" role="tab" aria-selected="' + (state.cat === id) + '" data-cat="' + id + '">' +
    (CAT_ICON[id] ?? '') + '<span>' + esc(name) + '</span><span class="n">' + n + '</span></button>';
  return '<div class="cat-tabs" role="tablist" aria-label="Categorias">' + tab('todos', 'Todos', products.length) +
    categories.filter((c) => counts.get(c.id)).map((c) => tab(c.id, c.name, counts.get(c.id))).join('') + '</div>';
}

async function renderHome() {
  const o = await api('overview');
  state.overview = o;
  if (!state.region) state.region = o.me.region;
  renderRegions(o.regions);
  renderStatus(o);
  renderProgress(o.progress);
  if (o.progress.running) startPolling();

  // A lista mostra só produtos com oferta disponível. Os demais seguem monitorados
  // e voltam para a lista sozinhos quando aparecer oferta.
  const sorted = [...o.products].sort((a, b) => b.active - a.active || a.id - b.id);
  const available = sorted.filter((p) => p.best);
  // Aba salva que ficou sem produtos (ex.: trocou a região) volta para "Todos".
  if (state.cat !== 'todos' && !available.some((p) => p.category === state.cat)) state.cat = 'todos';
  const inCat = (p) => state.cat === 'todos' || p.category === state.cat;
  const products = available.filter(inCat);
  const waiting = sorted.filter((p) => !p.best && inCat(p));
  const waitingList = waiting.length
    ? `<details class="waiting">
        <summary>${waiting.length} produto${waiting.length > 1 ? 's' : ''} monitorado${waiting.length > 1 ? 's' : ''} sem oferta disponível ${state.region === 'todas' ? 'no momento' : 'nesta região'}</summary>
        <ul>${waiting.map((p) => `<li><a href="#/produto/${p.id}">${esc(p.name)}</a>${delButton(p)}</li>`).join('')}</ul>
      </details>`
    : '';
  app.innerHTML = `
    <div class="fade-in">${kpis(o)}</div>
    <section class="section">
      <div class="section-head"><h2>Seus produtos</h2><span class="sub">Melhor preço ${state.region === 'todas' ? 'em todas as regiões' : `em ${esc(o.regions.find((r) => r.id === state.region)?.name)}`}</span></div>
      ${available.length ? catTabs(o.categories, available) : ''}
      <div class="cards">${products.map(productCard).join('') || `<div class="panel empty">${o.products.length ? 'Nenhum produto com oferta disponível agora.' : 'Nenhum produto. Clique em "Produto" para adicionar.'}</div>`}</div>
      ${waitingList}
    </section>
    <section class="section grid-2">
      <div>
        <div class="section-head"><h2>Alertas recentes</h2><span class="sub">quedas, promoções e estoque</span></div>
        <div class="panel">${o.events.length ? `<ul class="feed${state.allEvents ? '' : ' feed-short'}">${o.events.map((e) => eventItem(e)).join('')}</ul>${o.events.length > 6 ? `<button class="toggle-link more feed-more" id="toggleEvents">${state.allEvents ? 'Mostrar menos' : `Mostrar todos os ${o.events.length}`}</button>` : ''}` : `<div class="empty">${ICON.inbox}<div>Nenhuma alteração ainda. As mudanças aparecem a partir da 2ª coleta.</div></div>`}</div>
      </div>
      <div>
        <div class="section-head"><h2>Lojas</h2><span class="sub">última coleta</span></div>
        <div class="panel">${healthList(o)}</div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Sua conta</h2></div>
      ${accountPanel(o)}
    </section>
    ${peoplePanel(o)}
    <section class="section">
      <div class="section-head"><h2>Configurações</h2></div>
      ${settingsPanel(o)}
    </section>`;

  app.querySelectorAll('.card[data-href]').forEach((card) => {
    const go = (e) => {
      if (e.target.closest('.buy, .del-btn')) return;
      location.hash = card.dataset.href;
    };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) go(e); });
  });

  app.querySelectorAll('[data-del]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = o.products.find((x) => x.id === Number(btn.dataset.del));
      if (p) removeProduct(p, renderHome);
    }),
  );

  app.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      state.cat = b.dataset.cat;
      writePref('categoria', state.cat);
      renderHome();
    }),
  );

  $('#toggleEvents')?.addEventListener('click', () => { state.allEvents = !state.allEvents; renderHome(); });

  $('#logoutBtn')?.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    state.overview = null;
    showLogin();
  });

  $('#profileForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const me = await api('me', { method: 'PUT', body: { name: f.name.value, region: f.region.value } });
      // A região do perfil passa a ser a do painel neste aparelho também.
      state.region = me.region;
      writePref('regiao', me.region);
      toast('Perfil salvo');
      renderHome();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#inviteForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    $('#inviteError').textContent = '';
    try {
      const r = await api('users', { method: 'POST', body: { email: f.email.value, name: f.name.value } });
      if (r.devLink) {
        // Só no PC, sem e-mail configurado: copie o link e mande para a pessoa.
        await confirmDialog({ title: 'Convite criado', message: `E-mail não configurado neste PC. Envie este link para a pessoa: ${r.devLink}`, ok: 'OK' });
      } else toast(`Convite enviado para ${r.user.email}`);
      renderHome();
    } catch (err) {
      $('#inviteError').textContent = err.message;
    }
  });

  app.querySelectorAll('[data-reinvite]').forEach((b) =>
    b.addEventListener('click', async () => {
      const u = o.users.find((x) => x.id === Number(b.dataset.reinvite));
      try {
        const r = await api(`users/${u.id}/convite`, { method: 'POST' });
        if (r.devLink) await confirmDialog({ title: 'Novo link', message: `E-mail não configurado neste PC. Envie este link: ${r.devLink}`, ok: 'OK' });
        else toast(`Convite reenviado para ${u.email}`);
      } catch (err) {
        toast(err.message);
      }
    }),
  );

  app.querySelectorAll('[data-deluser]').forEach((b) =>
    b.addEventListener('click', async () => {
      const u = o.users.find((x) => x.id === Number(b.dataset.deluser));
      const ok = await confirmDialog({
        title: 'Remover pessoa?',
        message: `${u.name || u.email} perde o acesso e deixa de receber alertas. Produtos que só essa pessoa monitorava são apagados com o histórico.`,
        ok: 'Remover',
      });
      if (!ok) return;
      try {
        await api(`users/${u.id}`, { method: 'DELETE' });
        toast('Pessoa removida');
        renderHome();
      } catch (err) {
        toast(err.message);
      }
    }),
  );

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

function rankingRows(ranking, outOfStock = [], productId = null) {
  if (!ranking.length) {
    const searching = state.fetching?.id === productId && Date.now() < state.fetching.until;
    const msg = searching
      ? '<span class="spinner" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>Procurando os preços nas lojas… a página se atualiza sozinha.'
      : outOfStock.length
      ? `Encontramos este produto em ${esc(outOfStock.join(', '))}, mas está <strong>sem estoque agora</strong>. Você recebe um e-mail quando voltar.`
      : `Nenhuma oferta disponível ${state.region === 'todas' ? 'no momento' : 'nesta região'}.`;
    return `<tr><td colspan="5"><div class="empty">${msg}</div></td></tr>`;
  }
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
        <td class="price-cell num">${g.listPrice && g.listPrice > g.price ? `<span class="list">${brl(g.listPrice)}</span>` : ''}${brl(g.price)}${pixTag(g)}
          ${g.promo ? `<div><span class="badge badge-promo">-${g.discountPct}%</span></div>` : ''}</td>
        <td><div class="row-actions">
          ${voltLinks(g).length
            ? voltLinks(g).map((l) => `<a class="btn btn-ghost btn-sm" href="${esc(l.url)}" target="_blank" rel="noopener" title="Abrir a versão ${esc(l.voltage ?? '')} no site">${esc(l.voltage ?? 'site')}${ICON.ext}</a>`).join('')
            : g.url ? `<a class="btn btn-ghost btn-sm" href="${esc(g.url)}" target="_blank" rel="noopener" title="Abrir no site">${ICON.ext}</a>` : ''}
          <button class="btn btn-ghost btn-sm" data-reject="${esc((g.extKeys?.length ? g.extKeys : [g.stores[0].extKey ?? g.stores[0].id]).join(','))}" data-title="${esc(g.title)}" title="Não é este produto">${ICON.x}</button>
        </div></td>
      </tr>`;
    })
    .join('');
}

async function renderProduct(id) {
  const [d, o] = await Promise.all([api(`products/${id}`), state.overview ? Promise.resolve(state.overview) : api('overview')]);
  state.overview = o;
  if (!state.region) state.region = o.me.region;
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
              <span class="chip">${p.channels === 'todos' ? 'mercados + varejo' : 'só mercados'}</span>
              ${p.maxPrice ? `<span class="chip">até ${brl(p.maxPrice)}</span>` : ''}
            </div>
            <details class="search-rules">
              <summary>Como o produto é buscado</summary>
              <div class="chips">
                <span class="chip">busca: “${esc(p.query)}”</span>
                ${p.include.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
                ${p.exclude.map((t) => `<span class="chip chip-no" title="termo proibido">${esc(t)}</span>`).join('')}
                ${p.eans.map((t) => `<span class="chip">EAN ${esc(t)}</span>`).join('')}
              </div>
            </details>
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
            ? `<div class="price-hero num" style="margin-top:6px">${brlParts(best.price)}${pixTag(best)}</div>
               <div class="price-where"><span class="market-tag"><span class="dot" style="background:${marketColor(best.market)}"></span>${esc(best.marketName)}</span><span class="muted">· ${esc(best.stores.length > 1 ? `${best.stores.length} lojas` : best.stores[0].name)}</span></div>
               <div style="margin-top:12px">${buyButton(best, 'btn-primary')}</div>`
            : `<div class="kpi-value muted">—</div><div class="kpi-foot">${d.outOfStock.length ? 'sem estoque agora' : 'nenhuma oferta disponível'}</div>`}
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
          <tbody>${rankingRows(d.ranking, d.outOfStock, p.id)}</tbody>
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
  $('#delBtn').onclick = () => removeProduct(p, () => { location.hash = '#/'; });

  app.querySelectorAll('[data-accept]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`products/${id}/aceitar`, { method: 'POST', body: { key: b.dataset.accept } });
      toast('Anotado! O item entra no ranking na próxima coleta.');
      renderProduct(id);
    }),
  );
  app.querySelectorAll('[data-reject]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Descartar este item?',
        message: `"${b.dataset.title}" sai do ranking e não será mais comparado neste produto.`,
        ok: 'Descartar',
      });
      if (!ok) return;
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
const saveLabel = $('#saveBtn').textContent;

function openProductDialog(p = null) {
  editing = p;
  $('#dialogTitle').textContent = p ? 'Editar produto' : 'Ajustes avançados';
  $('#formError').textContent = '';
  form.name.value = p?.name ?? '';
  form.query.value = p?.query ?? '';
  form.include.value = (p?.include ?? []).join(', ');
  form.exclude.value = (p?.exclude ?? ['kit', 'miniatura']).join(', ');
  form.eans.value = (p?.eans ?? []).join(', ');
  form.channels.value = p?.channels ?? 'mercados';
  form.category.value = p?.category ?? 'auto';
  form.maxPrice.value = p?.maxPrice ? p.maxPrice.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
  form.active.checked = p?.active ?? true;
  dialog.showModal();
  form.name.focus();
}

$('#addBtn').addEventListener('click', () => openFind());
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
    category: form.category.value,
    active: form.active.checked,
  };
  if (!form.include.value.trim()) body.include = body.query.split(/\s+/).filter((w) => w.length > 1).join(',');
  try {
    $('#saveBtn').disabled = true;
    if (!editing) $('#saveBtn').textContent = 'Salvando e buscando imagem…';
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
    $('#saveBtn').textContent = saveLabel;
  }
});

// ---------- cadastro simplificado (procurar → escolher pela foto → aviso) ----------

const findDlg = $('#findDialog');
const findForm = $('#findForm');
const find = { step: 1, text: '', groups: [], selected: new Set(), searching: false };

function findStep(step) {
  find.step = step;
  findDlg.querySelectorAll('[data-step]').forEach((s) => (s.hidden = Number(s.dataset.step) !== step));
  $('#findError').textContent = '';
  $('#findBack').hidden = step === 1;
  $('#findAdvanced').hidden = step !== 1;
  const next = $('#findNext');
  next.textContent = step === 1 ? 'Procurar nas lojas' : step === 2 ? 'Continuar' : 'Começar a acompanhar';
  next.disabled = step === 2 && !find.selected.size;
  next.hidden = step === 2 && !find.groups.length && !find.searching;
}

function openFind() {
  find.groups = [];
  find.selected.clear();
  findForm.reset();
  findForm.querySelector('.find-limit').hidden = true;
  findStep(1);
  findDlg.showModal();
  findForm.texto.focus();
}

const chosenGroups = () => find.groups.filter((g) => find.selected.has(g.key));

function findItem(g) {
  const on = find.selected.has(g.key);
  const where = g.markets.length > 2 ? `${g.markets.slice(0, 2).join(', ')} e mais ${g.markets.length - 2}` : g.markets.join(' e ');
  return `<button type="button" class="find-item${on ? ' on' : ''}" data-pick="${esc(g.key)}" aria-pressed="${on}">
    ${thumb(g.image, true)}
    <span class="find-item-text">
      <span class="find-item-title">${esc(g.title)}</span>
      <span class="find-item-where">${esc(where)}</span>
      <span class="find-item-price">${g.price ? `${g.approximate ? 'cerca de ' : ''}${brl(g.price)}` : ''}${g.available ? '' : ' <span class="find-out">sem estoque agora</span>'}</span>
    </span>
    <span class="find-check" aria-hidden="true">${ICON.check}</span>
  </button>`;
}

function renderFindResults() {
  const inStock = find.groups.filter((g) => g.available);
  const out = find.groups.filter((g) => !g.available);
  $('#findLead').textContent = find.groups.length
    ? 'Toque no produto que você quer. Pode escolher mais de um, se for o mesmo produto em lojas diferentes.'
    : `Não encontramos "${find.text}" nas lojas agora.`;
  $('#findResults').innerHTML =
    (inStock.length ? `<div class="find-list">${inStock.map(findItem).join('')}</div>` : '') +
    (out.length
      ? `<details class="find-more"${inStock.length ? '' : ' open'}><summary>Também encontramos, mas sem estoque agora (${out.length})</summary>
          <p class="find-hint">Se escolher um destes, avisamos por e-mail quando voltar ao estoque.</p>
          <div class="find-list">${out.map(findItem).join('')}</div></details>`
      : '') +
    `<div class="find-none">
      <p class="find-hint">${find.groups.length ? 'Não é nenhum destes?' : 'Confira se o nome está certo e tente de novo, ou:'}</p>
      <button type="button" class="btn btn-secondary btn-lg" id="findAnyway">Acompanhar "${esc(find.text)}" mesmo assim</button>
    </div>`;
  $('#findAnyway').onclick = () => { find.selected.clear(); renderSummary(); findStep(3); };
  findStep(2);
}

$('#findResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  const key = b.dataset.pick;
  find.selected.has(key) ? find.selected.delete(key) : find.selected.add(key);
  b.classList.toggle('on', find.selected.has(key));
  b.setAttribute('aria-pressed', find.selected.has(key));
  $('#findNext').disabled = !find.selected.size;
});

function renderSummary() {
  const g = chosenGroups();
  const anyInStock = g.some((x) => x.available);
  $('#findSummary').innerHTML = g.length
    ? `<div class="find-chosen">${thumb(g[0].image)}<div><div class="find-item-title">${esc(g[0].title)}</div>
        <div class="find-hint">${g.length > 1 ? `e mais ${g.length - 1} parecido${g.length > 2 ? 's' : ''} · ` : ''}${anyInStock ? 'vamos comparar o preço em todas as lojas' : 'sem estoque agora: avisamos quando voltar'}</div></div></div>`
    : `<div class="find-chosen"><div><div class="find-item-title">${esc(find.text)}</div><div class="find-hint">Vamos procurar nas lojas a cada 6 horas e avisar quando aparecer.</div></div></div>`;
}

findForm.addEventListener('change', (e) => {
  if (e.target.name === 'aviso') {
    const limit = findForm.querySelector('.find-limit');
    limit.hidden = e.target.value !== 'limite';
    if (!limit.hidden) findForm.maxPrice.focus();
  }
});

findForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = $('#findNext');
  if (find.step === 1) {
    const text = findForm.texto.value.trim();
    if (text.length < 2) {
      $('#findError').textContent = 'Escreva o nome do produto.';
      return;
    }
    find.text = text;
    find.selected.clear();
    find.searching = true;
    $('#findLead').textContent = '';
    $('#findResults').innerHTML = `<div class="find-loading"><span class="spinner" aria-hidden="true"></span>Procurando "${esc(text)}" nas lojas… leva alguns segundos.</div>`;
    find.groups = [];
    findStep(2);
    next.hidden = true;
    try {
      const r = await api('buscar', { method: 'POST', body: { texto: text } });
      find.groups = r.groups;
    } catch (err) {
      $('#findResults').innerHTML = '';
      findStep(1);
      $('#findError').textContent = err.message;
      return;
    } finally {
      find.searching = false;
    }
    renderFindResults();
    return;
  }
  if (find.step === 2) {
    renderSummary();
    findStep(3);
    return;
  }
  // Passo 3: cria o produto.
  const limit = findForm.aviso.value === 'limite' ? findForm.maxPrice.value.trim() : '';
  if (findForm.aviso.value === 'limite' && !limit) {
    $('#findError').textContent = 'Escreva o preço máximo, ou escolha "Sempre que o preço cair".';
    return;
  }
  const chosen = chosenGroups();
  next.disabled = true;
  next.textContent = 'Salvando…';
  try {
    const r = await api('products/assistido', {
      method: 'POST',
      body: {
        texto: find.text,
        items: chosen.flatMap((g) => g.items),
        others: find.groups.filter((g) => !find.selected.has(g.key)).map((g) => g.title),
        maxPrice: limit || null,
      },
    });
    findDlg.close();
    state.overview = null;
    location.hash = `#/produto/${r.id}`;
    if (r.existing) toast('Este produto já está na sua lista');
    else if (r.collecting) watchFirstSearch(r.id);
  } catch (err) {
    $('#findError').textContent = err.message;
  } finally {
    next.disabled = false;
    if (find.step === 3) next.textContent = 'Começar a acompanhar';
  }
});

// Depois do cadastro: a página do produto mostra "procurando" e se atualiza até a 1ª busca terminar.
function watchFirstSearch(id) {
  state.fetching = { id, until: Date.now() + 90e3 };
  toast('Pronto! Procurando os preços nas lojas…');
  for (const ms of [20e3, 40e3, 65e3, 90e3]) {
    setTimeout(() => {
      if (ms === 90e3) state.fetching = null;
      if (location.hash === `#/produto/${id}` && !$('dialog[open]')) route();
    }, ms);
  }
}

$('#findBack').addEventListener('click', () => {
  if (find.step === 3 && !find.groups.length && !find.selected.size) return findStep(find.text ? 2 : 1);
  findStep(find.step - 1);
  if (find.step === 1) findForm.texto.focus();
});
$('#findAdvanced').addEventListener('click', () => { findDlg.close(); openProductDialog(); });
findDlg.querySelector('[data-close-find]').addEventListener('click', () => findDlg.close());

// ---------- roteamento ----------

async function route() {
  hideTooltip();
  const m = location.hash.match(/^#\/produto\/(\d+)/);
  try {
    if (m) await renderProduct(Number(m[1]));
    else await renderHome();
  } catch (err) {
    // Sem login, a tela fica limpa atrás do diálogo de entrada.
    app.innerHTML = $('#loginDialog').open ? '' : `<div class="panel empty">Não foi possível carregar: ${esc(err.message)}</div>`;
  } finally {
    app.classList.remove('loading');
  }
}

addEventListener('hashchange', () => { scrollTo(0, 0); route(); });
setInterval(() => { if (!state.polling && !document.hidden && !location.hash.startsWith('#/produto')) route(); }, 5 * 60 * 1000);
route();
