// Renderização da página de status. Sem dependências e sem build: lê
// data/status.json (gerado pelo monitor) e, se existir,
// data/incidents-manual.json (notas de incidente escritas à mão).
//
// Regra de honestidade: nada aqui inventa disponibilidade. Dado ausente,
// velho ou inválido aparece como "Sem dados"/"Desconhecido", nunca como
// operacional.

import {
  STALE_AFTER_MINUTES,
  TIME_ZONE,
  WINDOW_DAYS,
  ageMinutes,
  dayCounts,
  dayUptime,
  formatDuration,
  isStale,
  lastNDayKeys,
  overallState,
  saoPauloDateKey,
  windowUptime,
} from "./status-core.mjs";

const REFRESH_MS = 60_000;
const MOBILE_DAYS = 30;

const $ = (id) => document.getElementById(id);

const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const pctFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatDateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d).replace(",", "");
}
function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}
/** "2026-09-17" -> "17/09/2026" sem passar por fuso. */
function formatDayKey(key) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}
function formatPct(value) {
  // Nunca arredonda pra cima até 100% quando houve falha.
  const floored = Math.floor(value * 100) / 100;
  return `${pctFmt.format(floored)}%`;
}
function relativeAge(iso, now = new Date()) {
  const min = ageMinutes(iso, now);
  if (!Number.isFinite(min)) return "";
  if (min < 1) return "há menos de 1 minuto";
  if (min < 60) return `há ${Math.floor(min)} min`;
  if (min < 48 * 60) return `há ${Math.floor(min / 60)} h`;
  return `há ${Math.floor(min / 1440)} dias`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

const ICONS = {
  operational: '<path d="M5 12.5l4.5 4.5L19 7.5" />',
  degraded: '<path d="M12 7v6" /><path d="M12 16.5v.5" />',
  outage: '<path d="M7 7l10 10" /><path d="M17 7L7 17" />',
  unknown: '<path d="M9.5 9.2a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.3" /><path d="M12 16.8v.4" />',
};
function iconSvg(state) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = ICONS[state] ?? ICONS.unknown; // conteúdo estático, não vem dos dados
  return svg;
}

const OVERALL_TEXT = {
  operational: ["Todos os sistemas operacionais", "Nenhum problema detectado na última verificação."],
  degraded: ["Instabilidade", "Um ou mais serviços estão lentos ou fora do ar."],
  outage: ["Indisponível", "Os serviços monitorados não estão respondendo."],
  unknown: ["Status desconhecido", "Não há verificações recentes para afirmar o estado atual."],
};

const SERVICE_STATE_LABEL = {
  up: "Operacional",
  degraded: "Lento",
  down: "Indisponível",
  unknown: "Desconhecido",
};

function dayLevel(bucket) {
  const pct = dayUptime(bucket);
  if (pct == null) return "nodata";
  if (pct >= 100) return "ok";
  if (pct >= 95) return "partial";
  return "major";
}

// ---------------------------------------------------------------- dados

async function fetchJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { data: await res.json() };
}

function normalizeManualIncidents(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.incidents) ? raw.incidents : [];
  return list
    .filter((i) => i && typeof i.startedAt === "string" && !Number.isNaN(Date.parse(i.startedAt)))
    .map((i, idx) => ({
      id: `manual-${i.id ?? idx}`,
      title: typeof i.title === "string" ? i.title : null,
      serviceName: typeof i.serviceName === "string" ? i.serviceName : null,
      description: typeof i.description === "string" ? i.description : "",
      startedAt: i.startedAt,
      endedAt: typeof i.endedAt === "string" && !Number.isNaN(Date.parse(i.endedAt)) ? i.endedAt : null,
      severity: i.severity === "major" ? "major" : "partial",
      manual: true,
    }));
}

// ---------------------------------------------------------------- render

function renderOverall(state, detailOverride) {
  const box = $("overall");
  box.dataset.state = state;
  box.setAttribute("aria-busy", "false");
  const icon = box.querySelector(".overall-icon");
  icon.replaceChildren(iconSvg(state));
  const [title, detail] = OVERALL_TEXT[state];
  $("overall-title").textContent = title;
  $("overall-detail").textContent = detailOverride ?? detail;
}

function renderLastCheck(generatedAt, now) {
  const node = $("last-check");
  if (!generatedAt) {
    node.textContent = "Última verificação: nenhuma registrada.";
    return;
  }
  node.textContent = `Última verificação: ${formatDateTime(generatedAt)} (horário de Brasília) · ${relativeAge(generatedAt, now)}`;
}

function renderStaleWarning(data, now) {
  const box = $("stale-warning");
  if (data && data.generatedAt && isStale(data.generatedAt, now)) {
    box.textContent =
      `Os dados de monitoramento estão desatualizados: a última verificação foi ${relativeAge(data.generatedAt, now)} ` +
      `(o esperado é a cada ~5 min; acima de ${STALE_AFTER_MINUTES} min o estado passa a ser considerado desconhecido). ` +
      "Isso indica atraso do monitor, não necessariamente um problema no BarberPro.";
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

function barTooltip(key, bucket) {
  const pct = dayUptime(bucket);
  const date = formatDayKey(key);
  if (pct == null) {
    const unknown = bucket?.unknown ?? 0;
    const extra = unknown > 0 ? ` (${unknown} verificações sem resultado conclusivo)` : "";
    return { title: date, body: `Sem dados${extra}` };
  }
  const { up, determinate } = dayCounts(bucket);
  const failures = determinate - up;
  const slow = bucket.degraded ?? 0;
  let body = `${formatPct(pct)} disponível · ${determinate} verificações`;
  if (failures > 0) body += ` · ${failures} com falha`;
  if (slow > 0) body += ` · ${slow} lentas`;
  return { title: date, body };
}

function renderServices(data, now, stale) {
  const list = $("services");
  const todayKey = saoPauloDateKey(now);
  const keys = lastNDayKeys(todayKey, WINDOW_DAYS);

  if (!data || !Array.isArray(data.services) || data.services.length === 0) {
    list.replaceChildren(
      el("li", { class: "service" }, [el("p", { class: "empty", text: "Nenhum serviço monitorado ainda." })])
    );
    return;
  }

  const items = data.services.map((svc) => {
    const current = svc.current;
    const currentStale = stale || !current || isStale(current.checkedAt, now);
    const state = currentStale ? "unknown" : current.state;
    const label = SERVICE_STATE_LABEL[state] ?? "Desconhecido";

    let meta = null;
    if (svc.type === "health" && !svc.firstSeenOkAt) {
      meta = "Verificação do banco ainda não disponível neste servidor — sem resultado conclusivo até a primeira resposta válida.";
    } else if (!currentStale && current?.latencyMs != null) {
      meta = `Tempo de resposta na última verificação: ${current.latencyMs} ms`;
    }

    const uptime = windowUptime(svc.daily, keys);
    const titleId = `svc-${svc.id}`;

    const bars = el("div", {
      class: "bars",
      role: "group",
      "aria-label": `Disponibilidade diária de ${svc.name} nos últimos ${WINDOW_DAYS} dias. Use as setas para navegar pelos dias.`,
    });
    keys.forEach((key, idx) => {
      const bucket = svc.daily?.[key];
      const tip = barTooltip(key, bucket);
      const bar = el("span", {
        class: "bar",
        role: "img",
        tabindex: idx === keys.length - 1 ? "0" : "-1",
        "data-level": dayLevel(bucket),
        "data-old": idx < keys.length - MOBILE_DAYS ? "true" : null,
        "aria-label": `${tip.title}: ${tip.body}`,
        "data-tip-title": tip.title,
        "data-tip-body": tip.body,
      });
      bars.append(bar);
    });

    const uptimeText =
      uptime.percent == null
        ? "Sem dados no período"
        : `${formatPct(uptime.percent)} de disponibilidade, calculado sobre ${uptime.daysWithData} ${
            uptime.daysWithData === 1 ? "dia" : "dias"
          } com dados`;

    return el("li", { class: "service", "aria-labelledby": titleId }, [
      el("div", { class: "service-top" }, [
        el("div", {}, [
          el("h3", { class: "service-name", id: titleId, text: svc.name }),
          svc.description ? el("p", { class: "service-desc", text: svc.description }) : null,
        ]),
        el("span", { class: "pill", "data-state": state, text: label }),
      ]),
      meta ? el("p", { class: "service-meta", text: meta }) : null,
      bars,
      el("div", { class: "bars-foot" }, [
        el("span", {}, [
          el("span", { class: "label-long", text: `${WINDOW_DAYS} dias atrás` }),
          el("span", { class: "label-short", text: `${MOBILE_DAYS} dias atrás` }),
        ]),
        el("span", { class: "bars-uptime", text: uptimeText }),
        el("span", { text: "Hoje" }),
      ]),
    ]);
  });
  list.replaceChildren(...items);
}

function renderIncidents(data, manual, now) {
  const root = $("incidents");
  const auto = (data?.incidents ?? []).map((i) => ({
    id: i.id,
    title: null,
    serviceName: i.serviceName,
    description: i.description,
    startedAt: i.startedAt,
    endedAt: i.endedAt ?? null,
    severity: "major",
    manual: false,
  }));
  const all = [...auto, ...manual].sort((a, b) => {
    // abertos primeiro, depois do mais recente pro mais antigo
    if ((a.endedAt == null) !== (b.endedAt == null)) return a.endedAt == null ? -1 : 1;
    return Date.parse(b.startedAt) - Date.parse(a.startedAt);
  });

  if (all.length === 0) {
    const since = data?.monitoringSince;
    root.replaceChildren(
      el("p", {
        class: "empty",
        text: since
          ? `Nenhum incidente registrado desde o início do monitoramento (${formatDate(since)}).`
          : "Nenhum incidente registrado. O monitoramento ainda não começou.",
      })
    );
    return;
  }

  const items = all.map((i) => {
    const open = i.endedAt == null;
    const title = i.title ?? (i.serviceName ? `Indisponibilidade: ${i.serviceName}` : "Incidente");
    const pillState = open ? (i.severity === "major" ? "down" : "degraded") : "up";
    const duration = formatDuration((open ? now.getTime() : Date.parse(i.endedAt)) - Date.parse(i.startedAt));
    const times = open
      ? `Início: ${formatDateTime(i.startedAt)} · em andamento há ${duration}`
      : `Início: ${formatDateTime(i.startedAt)} · Fim: ${formatDateTime(i.endedAt)} · Duração: ${duration}`;
    return el("li", { class: "incident" }, [
      el("div", { class: "incident-head" }, [
        el("h3", { text: title }),
        el("span", { class: "pill", "data-state": pillState, text: open ? "Em andamento" : "Resolvido" }),
      ]),
      i.serviceName && i.title ? el("p", { class: "incident-times", text: `Serviço afetado: ${i.serviceName}` }) : null,
      i.description ? el("p", { class: "incident-body", text: i.description }) : null,
      el("p", {
        class: "incident-times",
        text: `${times} (horário de Brasília)${i.manual ? " · nota da equipe" : ""}`,
      }),
    ]);
  });
  root.replaceChildren(el("ul", { class: "incident-list" }, items));
}

// ---------------------------------------------------------------- tooltip

const tooltip = $("tooltip");
function showTip(bar) {
  tooltip.replaceChildren(
    el("strong", { text: bar.dataset.tipTitle }),
    document.createTextNode(bar.dataset.tipBody)
  );
  tooltip.hidden = false;
  const r = bar.getBoundingClientRect();
  const t = tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
  const top = r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
function hideTip() {
  tooltip.hidden = true;
}

function visibleBars(group) {
  return [...group.querySelectorAll(".bar")].filter((b) => b.getClientRects().length > 0);
}

function wireBars() {
  const list = $("services");
  list.addEventListener("mouseover", (e) => {
    const bar = e.target.closest?.(".bar");
    if (bar) showTip(bar);
  });
  list.addEventListener("mouseout", (e) => {
    if (e.target.closest?.(".bar")) hideTip();
  });
  list.addEventListener("focusin", (e) => {
    const bar = e.target.closest?.(".bar");
    if (bar) showTip(bar);
  });
  list.addEventListener("focusout", hideTip);
  list.addEventListener("keydown", (e) => {
    const bar = e.target.closest?.(".bar");
    if (!bar) return;
    if (e.key === "Escape") return hideTip();
    const bars = visibleBars(bar.parentElement);
    let idx = bars.indexOf(bar);
    if (e.key === "ArrowLeft") idx--;
    else if (e.key === "ArrowRight") idx++;
    else if (e.key === "Home") idx = 0;
    else if (e.key === "End") idx = bars.length - 1;
    else return;
    e.preventDefault();
    const next = bars[Math.max(0, Math.min(bars.length - 1, idx))];
    if (!next || next === bar) return;
    bar.setAttribute("tabindex", "-1");
    next.setAttribute("tabindex", "0");
    next.focus();
  });
  // Toque: mostra o tooltip do dia tocado.
  list.addEventListener("click", (e) => {
    const bar = e.target.closest?.(".bar");
    if (bar) showTip(bar);
  });
  window.addEventListener("scroll", hideTip, { passive: true });
}

// ---------------------------------------------------------------- ciclo

async function load() {
  const now = new Date();
  let status;
  try {
    status = await fetchJson("data/status.json");
  } catch {
    status = { error: true };
  }
  let manual = [];
  try {
    const m = await fetchJson("data/incidents-manual.json");
    manual = m.data ? normalizeManualIncidents(m.data) : [];
  } catch {
    manual = [];
  }

  if (status.missing) {
    renderOverall("unknown", "Desconhecido — o monitoramento ainda não iniciou.");
    renderLastCheck(null, now);
    $("stale-warning").hidden = true;
    renderServices(null, now, true);
    renderIncidents(null, manual, now);
    return;
  }
  if (status.error || !status.data || !Array.isArray(status.data.services)) {
    renderOverall("unknown", "Não foi possível carregar os dados de monitoramento.");
    renderLastCheck(null, now);
    $("stale-warning").hidden = true;
    renderServices(null, now, true);
    renderIncidents(null, manual, now);
    return;
  }

  const data = status.data;
  const stale = isStale(data.generatedAt, now);
  renderOverall(overallState(data, now));
  renderLastCheck(data.generatedAt, now);
  renderStaleWarning(data, now);
  renderServices(data, now, stale);
  renderIncidents(data, manual, now);
}

wireBars();
load();
setInterval(() => {
  // Não recarrega enquanto alguém navega pelas barras com o teclado.
  if (document.activeElement?.classList?.contains("bar")) return;
  load();
}, REFRESH_MS);
