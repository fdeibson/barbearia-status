// Funções puras do monitor: classificação de uma verificação, agregação
// diária, corte da janela e gestão automática de incidentes. Nada aqui faz
// rede nem disco — isso fica em check.mjs.

import { WINDOW_DAYS, addDaysToKey, saoPauloDateKey } from "../site/assets/status-core.mjs";

export * from "../site/assets/status-core.mjs";

export const SCHEMA_VERSION = 1;
export const SLOW_MS = 5_000;
export const RECENT_LIMIT = 50;
export const INCIDENT_RETENTION_DAYS = 365;
/** Quantos "down" seguidos abrem um incidente. */
export const DOWN_STREAK_TO_OPEN = 2;

/**
 * Classifica a resposta de uma sonda.
 *
 * `probe`: { httpStatus: number|null, latencyMs: number|null, body: string|null, error: string|null }
 * `service`: entrada de services.json ({ type: "http"|"health", expectStatus })
 * `serviceState`: estado persistido do serviço (usa `firstSeenOkAt`)
 *
 * Retorna { outcome: "up"|"down"|"degraded"|"unknown", healthOk: boolean }.
 * `healthOk` indica que um endpoint de health respondeu JSON válido com
 * status "ok" (marca `firstSeenOkAt`).
 */
export function classifyProbe(probe, service, serviceState = {}, slowMs = SLOW_MS) {
  const expectStatus = service.expectStatus ?? 200;
  const slow = typeof probe.latencyMs === "number" && probe.latencyMs > slowMs;

  if (service.type === "health") {
    const health = parseHealth(probe.body);
    if (probe.httpStatus === expectStatus && health?.status === "ok") {
      return { outcome: slow ? "degraded" : "up", healthOk: true };
    }
    // Endpoint respondeu JSON de health válido, mas acusando problema
    // (ex.: banco fora, 503 + status "degraded"): o endpoint claramente
    // existe, então é uma falha real, não "desconhecido".
    if (health && (health.status === "degraded" || health.status === "error")) {
      return { outcome: "down", healthOk: false };
    }
    // Sem JSON de health válido (404 HTML antes do deploy, timeout, etc.):
    // só conta como falha se o endpoint já respondeu ok alguma vez.
    return { outcome: serviceState.firstSeenOkAt ? "down" : "unknown", healthOk: false };
  }

  if (probe.httpStatus === expectStatus) {
    return { outcome: slow ? "degraded" : "up", healthOk: false };
  }
  return { outcome: "down", healthOk: false };
}

function parseHealth(body) {
  if (typeof body !== "string" || body.length === 0 || body.length > 10_000) return null;
  try {
    const json = JSON.parse(body);
    if (json && typeof json === "object" && typeof json.status === "string" && json.checks) {
      return json;
    }
  } catch {
    // não é JSON
  }
  return null;
}

/** Deve repetir a sonda antes de aceitar o resultado? (só falhas e desconhecidos) */
export function shouldRetry(outcome) {
  return outcome === "down" || outcome === "unknown";
}

/** Remove do mapa diário os dias fora da janela de `days` dias terminando em `todayKey`. */
export function trimDaily(daily, todayKey, days = WINDOW_DAYS) {
  const oldest = addDaysToKey(todayKey, -(days - 1));
  const out = {};
  for (const key of Object.keys(daily ?? {}).sort()) {
    if (key >= oldest && key <= todayKey) out[key] = daily[key];
  }
  return out;
}

export function emptyServiceState(service) {
  return {
    id: service.id,
    name: service.name,
    url: null,
    firstSeenOkAt: null,
    current: null,
    daily: {},
    recent: [],
  };
}

/**
 * Aplica uma verificação ao estado de um serviço (imutável: devolve novo objeto).
 * `check`: { at: ISO, outcome, httpStatus, latencyMs, healthOk }
 */
export function applyCheck(serviceState, check, { days = WINDOW_DAYS, recentLimit = RECENT_LIMIT } = {}) {
  const at = new Date(check.at);
  const dayKey = saoPauloDateKey(at);
  const prevBucket = serviceState.daily?.[dayKey] ?? { up: 0, down: 0, degraded: 0, unknown: 0, total: 0 };
  const bucket = {
    up: prevBucket.up,
    down: prevBucket.down,
    degraded: prevBucket.degraded,
    unknown: prevBucket.unknown,
    total: prevBucket.total + 1,
  };
  bucket[check.outcome] = (bucket[check.outcome] ?? 0) + 1;

  const entry = {
    at: check.at,
    outcome: check.outcome,
    httpStatus: check.httpStatus ?? null,
    latencyMs: check.latencyMs ?? null,
  };

  return {
    ...serviceState,
    firstSeenOkAt: serviceState.firstSeenOkAt ?? (check.healthOk ? check.at : null),
    current: {
      state: check.outcome,
      checkedAt: check.at,
      httpStatus: entry.httpStatus,
      latencyMs: entry.latencyMs,
    },
    daily: trimDaily({ ...serviceState.daily, [dayKey]: bucket }, dayKey, days),
    recent: [...(serviceState.recent ?? []), entry].slice(-recentLimit),
  };
}

function describeIncident(serviceName, httpStatus) {
  const detail =
    httpStatus == null
      ? "sem resposta: tempo esgotado ou falha de conexão"
      : `resposta HTTP ${httpStatus} inesperada`;
  return `${serviceName} ficou indisponível — ${DOWN_STREAK_TO_OPEN} verificações seguidas falharam (${detail}).`;
}

/**
 * Abre/resolve incidentes automáticos de um serviço após aplicar uma verificação.
 * - abre quando as últimas N verificações do serviço são "down" e não há incidente aberto;
 * - resolve quando chega um "up" (ou "degraded" — respondeu, só que lento).
 * "unknown" não abre nem resolve nada.
 */
export function updateIncidents(incidents, serviceState) {
  const list = [...(incidents ?? [])];
  const recent = serviceState.recent ?? [];
  const last = recent[recent.length - 1];
  if (!last) return list;

  const openIdx = list.findIndex((i) => i.serviceId === serviceState.id && i.endedAt == null);

  if (last.outcome === "up" || last.outcome === "degraded") {
    if (openIdx >= 0) {
      list[openIdx] = { ...list[openIdx], endedAt: last.at, status: "resolved" };
    }
    return list;
  }

  if (last.outcome === "down" && openIdx < 0) {
    const streak = recent.slice(-DOWN_STREAK_TO_OPEN);
    if (streak.length === DOWN_STREAK_TO_OPEN && streak.every((c) => c.outcome === "down")) {
      const startedAt = streak[0].at;
      list.push({
        id: `${serviceState.id}-${startedAt}`,
        serviceId: serviceState.id,
        serviceName: serviceState.name,
        startedAt,
        endedAt: null,
        status: "open",
        auto: true,
        description: describeIncident(serviceState.name, last.httpStatus),
      });
    }
  }
  return list;
}

/** Mantém incidentes abertos e os resolvidos há menos de `days` dias. */
export function trimIncidents(incidents, now = new Date(), days = INCIDENT_RETENTION_DAYS) {
  const limit = now.getTime() - days * 24 * 60 * 60 * 1000;
  return (incidents ?? []).filter((i) => i.endedAt == null || Date.parse(i.endedAt) >= limit);
}

/**
 * Monta o novo status.json a partir do anterior (ou null), da configuração e
 * das verificações desta rodada (mapa serviceId -> check).
 */
export function buildNextStatus(previous, services, checksById, now = new Date()) {
  const nowIso = now.toISOString();
  const prevServices = new Map((previous?.services ?? []).map((s) => [s.id, s]));
  let incidents = previous?.incidents ?? [];

  const nextServices = services.map((service) => {
    let state = prevServices.get(service.id) ?? emptyServiceState(service);
    state = {
      ...state,
      name: service.name,
      description: service.description ?? null,
      type: service.type ?? "http",
      url: service.displayUrl ?? service.url ?? null,
    };
    const check = checksById[service.id];
    if (check) {
      state = applyCheck(state, check);
      incidents = updateIncidents(incidents, state);
    }
    return state;
  });

  // Incidente aberto de um serviço removido da configuração fica aberto pra
  // sempre se não for fechado aqui.
  const activeIds = new Set(services.map((s) => s.id));
  incidents = incidents.map((i) =>
    i.endedAt == null && !activeIds.has(i.serviceId) ? { ...i, endedAt: nowIso, status: "resolved" } : i
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso,
    monitoringSince: previous?.monitoringSince ?? nowIso,
    services: nextServices,
    incidents: trimIncidents(incidents, now),
  };
}
