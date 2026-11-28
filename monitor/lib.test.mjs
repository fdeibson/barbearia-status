// Testes das funções puras do monitor e da lógica compartilhada com a página.
// Rodar: node --test status-page/monitor/

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDaysToKey,
  applyCheck,
  buildNextStatus,
  classifyProbe,
  emptyServiceState,
  formatDuration,
  isStale,
  lastNDayKeys,
  overallState,
  saoPauloDateKey,
  shouldRetry,
  trimDaily,
  trimIncidents,
  updateIncidents,
  windowUptime,
  dayUptime,
} from "./lib.mjs";

const httpService = { id: "web", name: "Aplicação web", type: "http", path: "/login", expectStatus: 200 };
const healthService = { id: "api-db", name: "API e banco de dados", type: "health", path: "/api/health", expectStatus: 200 };

const probe = (over = {}) => ({ httpStatus: 200, latencyMs: 120, body: null, error: null, ...over });
const check = (at, outcome, over = {}) => ({ at, outcome, httpStatus: 200, latencyMs: 100, healthOk: false, ...over });

describe("datas no fuso de Brasília", () => {
  it("usa a data civil de São Paulo, não a UTC", () => {
    // 02:30 UTC do dia 18 = 23:30 do dia 17 em Brasília (UTC-3)
    assert.equal(saoPauloDateKey(new Date("2026-09-18T02:30:00Z")), "2026-09-17");
    assert.equal(saoPauloDateKey(new Date("2026-09-18T03:00:00Z")), "2026-09-18");
  });

  it("soma dias atravessando mês e ano", () => {
    assert.equal(addDaysToKey("2026-03-01", -1), "2026-02-28");
    assert.equal(addDaysToKey("2026-12-31", 1), "2027-01-01");
  });

  it("gera 90 dias terminando hoje, em ordem", () => {
    const keys = lastNDayKeys("2026-09-17", 90);
    assert.equal(keys.length, 90);
    assert.equal(keys[89], "2026-09-17");
    assert.equal(keys[0], "2026-06-20");
  });
});

describe("classifyProbe", () => {
  it("http: 200 rápido = up, lento = degraded, outro código = down", () => {
    assert.equal(classifyProbe(probe(), httpService).outcome, "up");
    assert.equal(classifyProbe(probe({ latencyMs: 5_001 }), httpService).outcome, "degraded");
    assert.equal(classifyProbe(probe({ httpStatus: 502 }), httpService).outcome, "down");
    assert.equal(classifyProbe(probe({ httpStatus: null, latencyMs: null, error: "timeout" }), httpService).outcome, "down");
  });

  it("health: JSON ok = up e marca healthOk", () => {
    const r = classifyProbe(probe({ body: '{"status":"ok","checks":{"app":"ok","database":"ok"}}' }), healthService);
    assert.deepEqual(r, { outcome: "up", healthOk: true });
  });

  it("health: 404 HTML antes do primeiro deploy = unknown, nunca down", () => {
    const r = classifyProbe(probe({ httpStatus: 404, body: null }), healthService, { firstSeenOkAt: null });
    assert.equal(r.outcome, "unknown");
    const timeout = classifyProbe(probe({ httpStatus: null, error: "timeout" }), healthService, {});
    assert.equal(timeout.outcome, "unknown");
  });

  it("health: depois de já ter respondido ok, a mesma falha vira down", () => {
    const r = classifyProbe(probe({ httpStatus: 404 }), healthService, { firstSeenOkAt: "2026-09-01T00:00:00Z" });
    assert.equal(r.outcome, "down");
  });

  it("health: JSON válido acusando banco fora = down mesmo sem histórico", () => {
    const body = '{"status":"degraded","checks":{"app":"ok","database":"error"}}';
    assert.equal(classifyProbe(probe({ httpStatus: 503, body }), healthService, {}).outcome, "down");
  });

  it("repete só falhas e desconhecidos", () => {
    assert.equal(shouldRetry("down"), true);
    assert.equal(shouldRetry("unknown"), true);
    assert.equal(shouldRetry("up"), false);
    assert.equal(shouldRetry("degraded"), false);
  });
});

describe("agregação diária", () => {
  it("conta cada resultado no dia de Brasília correto", () => {
    let s = emptyServiceState(httpService);
    s = applyCheck(s, check("2026-09-17T12:00:00Z", "up"));
    s = applyCheck(s, check("2026-09-17T12:05:00Z", "down", { httpStatus: 500 }));
    s = applyCheck(s, check("2026-09-17T12:10:00Z", "degraded"));
    s = applyCheck(s, check("2026-09-18T02:59:00Z", "unknown")); // ainda dia 17 em SP
    s = applyCheck(s, check("2026-09-18T03:01:00Z", "up")); // dia 18 em SP
    assert.deepEqual(s.daily["2026-09-17"], { up: 1, down: 1, degraded: 1, unknown: 1, total: 4 });
    assert.deepEqual(s.daily["2026-09-18"], { up: 1, down: 0, degraded: 0, unknown: 0, total: 1 });
    assert.equal(s.current.state, "up");
    assert.equal(s.current.checkedAt, "2026-09-18T03:01:00Z");
  });

  it("guarda só as últimas N verificações brutas", () => {
    let s = emptyServiceState(httpService);
    for (let i = 0; i < 60; i++) {
      s = applyCheck(s, check(new Date(Date.UTC(2026, 8, 17, 12, i)).toISOString(), "up"), { recentLimit: 50 });
    }
    assert.equal(s.recent.length, 50);
    assert.equal(s.recent[49].at, "2026-09-17T12:59:00.000Z");
  });

  it("firstSeenOkAt é gravado uma vez e nunca sobrescrito", () => {
    let s = emptyServiceState(healthService);
    s = applyCheck(s, check("2026-09-17T12:00:00Z", "unknown"));
    assert.equal(s.firstSeenOkAt, null);
    s = applyCheck(s, check("2026-09-17T12:05:00Z", "up", { healthOk: true }));
    s = applyCheck(s, check("2026-09-17T12:10:00Z", "up", { healthOk: true }));
    assert.equal(s.firstSeenOkAt, "2026-09-17T12:05:00Z");
  });
});

describe("janela de 90 dias", () => {
  it("trimDaily remove dias anteriores à janela e posteriores a hoje", () => {
    const daily = {
      "2026-06-19": { up: 1, total: 1 },
      "2026-06-20": { up: 2, total: 2 },
      "2026-09-17": { up: 3, total: 3 },
      "2026-09-18": { up: 4, total: 4 },
    };
    assert.deepEqual(Object.keys(trimDaily(daily, "2026-09-17", 90)), ["2026-06-20", "2026-09-17"]);
  });

  it("applyCheck já corta a janela ao gravar", () => {
    let s = { ...emptyServiceState(httpService), daily: { "2026-01-01": { up: 9, down: 0, degraded: 0, unknown: 0, total: 9 } } };
    s = applyCheck(s, check("2026-09-17T12:00:00Z", "up"));
    assert.deepEqual(Object.keys(s.daily), ["2026-09-17"]);
  });
});

describe("cálculo de disponibilidade", () => {
  it("dia sem verificações ou só com unknown = sem dados (null)", () => {
    assert.equal(dayUptime(undefined), null);
    assert.equal(dayUptime({ up: 0, down: 0, degraded: 0, unknown: 5, total: 5 }), null);
  });

  it("degraded conta como disponível; unknown é ignorado", () => {
    assert.equal(dayUptime({ up: 2, down: 1, degraded: 1, unknown: 10, total: 14 }), 75);
  });

  it("janela ignora dias sem dados e informa quantos dias tinham dados", () => {
    const keys = lastNDayKeys("2026-09-17", 90);
    const daily = {
      "2026-09-16": { up: 9, down: 1, degraded: 0, unknown: 0, total: 10 },
      "2026-09-17": { up: 10, down: 0, degraded: 0, unknown: 0, total: 10 },
      "2026-09-15": { up: 0, down: 0, degraded: 0, unknown: 3, total: 3 },
    };
    const r = windowUptime(daily, keys);
    assert.equal(r.daysWithData, 2);
    assert.equal(r.days, 90);
    assert.equal(r.percent, 95); // 19/20, não diluído pelos 88 dias sem dados
  });

  it("sem nenhum dado = percent null (nunca 100%)", () => {
    assert.deepEqual(windowUptime({}, lastNDayKeys("2026-09-17", 90)), { percent: null, daysWithData: 0, days: 90 });
  });
});

describe("incidentes automáticos", () => {
  const withRecent = (outcomes) => ({
    ...emptyServiceState(httpService),
    recent: outcomes.map((o, i) => ({ at: `2026-09-17T12:${String(i * 5).padStart(2, "0")}:00Z`, outcome: o, httpStatus: o === "down" ? 502 : 200 })),
  });

  it("uma falha isolada não abre incidente", () => {
    assert.deepEqual(updateIncidents([], withRecent(["up", "down"])), []);
  });

  it("duas falhas seguidas abrem incidente começando na primeira", () => {
    const list = updateIncidents([], withRecent(["up", "down", "down"]));
    assert.equal(list.length, 1);
    assert.equal(list[0].serviceId, "web");
    assert.equal(list[0].startedAt, "2026-09-17T12:05:00Z");
    assert.equal(list[0].endedAt, null);
    assert.equal(list[0].status, "open");
    assert.match(list[0].description, /HTTP 502/);
  });

  it("não duplica incidente já aberto", () => {
    const first = updateIncidents([], withRecent(["down", "down"]));
    assert.equal(updateIncidents(first, withRecent(["down", "down", "down"])).length, 1);
  });

  it("unknown no meio não conta como falha seguida nem resolve", () => {
    assert.deepEqual(updateIncidents([], withRecent(["down", "unknown", "down"])), []);
    const open = updateIncidents([], withRecent(["down", "down"]));
    const still = updateIncidents(open, withRecent(["down", "down", "unknown"]));
    assert.equal(still[0].endedAt, null);
  });

  it("resolve no primeiro up", () => {
    const open = updateIncidents([], withRecent(["down", "down"]));
    const resolved = updateIncidents(open, withRecent(["down", "down", "up"]));
    assert.equal(resolved[0].status, "resolved");
    assert.equal(resolved[0].endedAt, "2026-09-17T12:10:00Z");
  });

  it("mantém abertos e resolvidos há menos de 1 ano", () => {
    const now = new Date("2026-09-17T00:00:00Z");
    const list = [
      { id: "a", endedAt: "2025-09-01T00:00:00Z" },
      { id: "b", endedAt: "2026-01-01T00:00:00Z" },
      { id: "c", endedAt: null, startedAt: "2020-01-01T00:00:00Z" },
    ];
    assert.deepEqual(trimIncidents(list, now).map((i) => i.id), ["b", "c"]);
  });
});

describe("buildNextStatus", () => {
  it("preserva monitoringSince e acumula entre rodadas", () => {
    const services = [httpService, healthService];
    const t1 = new Date("2026-09-17T12:00:00Z");
    const s1 = buildNextStatus(null, services, {
      web: check(t1.toISOString(), "up"),
      "api-db": check(t1.toISOString(), "unknown", { httpStatus: 404 }),
    }, t1);
    assert.equal(s1.monitoringSince, t1.toISOString());
    const t2 = new Date("2026-09-17T12:05:00Z");
    const s2 = buildNextStatus(s1, services, {
      web: check(t2.toISOString(), "down", { httpStatus: 500 }),
      "api-db": check(t2.toISOString(), "unknown", { httpStatus: 404 }),
    }, t2);
    assert.equal(s2.monitoringSince, t1.toISOString());
    assert.equal(s2.generatedAt, t2.toISOString());
    assert.equal(s2.services[0].daily["2026-09-17"].total, 2);
    assert.equal(s2.services[1].daily["2026-09-17"].unknown, 2);
    assert.equal(s2.incidents.length, 0);
  });

  it("fecha incidente aberto de serviço removido da configuração", () => {
    const prev = {
      monitoringSince: "2026-09-01T00:00:00Z",
      services: [],
      incidents: [{ id: "x", serviceId: "velho", endedAt: null, status: "open" }],
    };
    const now = new Date("2026-09-17T12:00:00Z");
    const next = buildNextStatus(prev, [httpService], { web: check(now.toISOString(), "up") }, now);
    assert.equal(next.incidents[0].status, "resolved");
  });
});

describe("dados velhos e estado geral", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const svc = (state, checkedAt = "2026-09-17T11:55:00Z") => ({ current: { state, checkedAt } });

  it("isStale considera o limite em minutos e ausência de data", () => {
    assert.equal(isStale("2026-09-17T11:31:00Z", now, 30), false);
    assert.equal(isStale("2026-09-17T11:29:00Z", now, 30), true);
    assert.equal(isStale(null, now), true);
    assert.equal(isStale("lixo", now), true);
  });

  it("sem dados ou dados velhos = unknown", () => {
    assert.equal(overallState(null, now), "unknown");
    assert.equal(overallState({ generatedAt: "2026-09-17T10:00:00Z", services: [svc("up")] }, now), "unknown");
  });

  it("combina estados dos serviços", () => {
    const g = "2026-09-17T11:55:00Z";
    assert.equal(overallState({ generatedAt: g, services: [svc("up"), svc("unknown")] }, now), "operational");
    assert.equal(overallState({ generatedAt: g, services: [svc("up"), svc("degraded")] }, now), "degraded");
    assert.equal(overallState({ generatedAt: g, services: [svc("up"), svc("down")] }, now), "degraded");
    assert.equal(overallState({ generatedAt: g, services: [svc("down"), svc("down"), svc("unknown")] }, now), "outage");
    assert.equal(overallState({ generatedAt: g, services: [svc("unknown")] }, now), "unknown");
  });

  it("formata duração", () => {
    assert.equal(formatDuration(30_000), "menos de 1 min");
    assert.equal(formatDuration(45 * 60_000), "45 min");
    assert.equal(formatDuration(125 * 60_000), "2 h 5 min");
    assert.equal(formatDuration(26 * 60 * 60_000), "1 d 2 h");
  });
});
