#!/usr/bin/env node
// Monitor da página de status. Node 20+, sem dependências (fetch global).
//
// Uso:
//   node monitor/check.mjs [caminho/do/status.json]
//
// Variáveis de ambiente:
//   STATUS_DATA_FILE   caminho do status.json (se não vier como argumento)
//   STATUS_BASE_URL    sobrescreve o baseUrl de services.json (testes locais)
//   STATUS_SERVICES    caminho alternativo para services.json
//
// Faz uma rodada de verificações, acumula no status.json e sai com código 0
// mesmo quando algum serviço está fora — falha de serviço é dado, não erro
// do monitor. Só sai com código != 0 se não conseguir ler a configuração ou
// gravar o arquivo.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNextStatus, classifyProbe, shouldRetry } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 5_000;
const MAX_BODY_BYTES = 10_000;

const dataFile = path.resolve(
  process.argv[2] ?? process.env.STATUS_DATA_FILE ?? path.join(HERE, "..", "site", "data", "status.json")
);
const servicesFile = path.resolve(process.env.STATUS_SERVICES ?? path.join(HERE, "services.json"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "user-agent": "barberpro-status-monitor/1.0 (+https://barbearia.hostcapixaba.com.br/status)",
        accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      },
    });
    // Só lê o corpo quando pode ser JSON de health (limitado), o resto descarta.
    let body = null;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      body = (await res.text()).slice(0, MAX_BODY_BYTES);
    } else {
      await res.body?.cancel();
    }
    return {
      httpStatus: res.status,
      latencyMs: Math.round(performance.now() - started),
      body,
      error: null,
    };
  } catch (err) {
    return {
      httpStatus: null,
      latencyMs: null,
      body: null,
      error: err?.name === "TimeoutError" ? "timeout" : "network",
    };
  }
}

async function checkService(service, baseUrl, serviceState) {
  const url = new URL(service.path, baseUrl).toString();
  let result = await probe(url);
  let classified = classifyProbe(result, service, serviceState);
  if (shouldRetry(classified.outcome)) {
    await sleep(RETRY_DELAY_MS);
    result = await probe(url);
    classified = classifyProbe(result, service, serviceState);
  }
  return {
    at: new Date().toISOString(),
    outcome: classified.outcome,
    healthOk: classified.healthOk,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`Não foi possível ler ${file}: ${err.message}`);
  }
}

async function main() {
  const config = await readJson(servicesFile, null);
  if (!config || !Array.isArray(config.services)) {
    throw new Error(`Configuração inválida ou ausente: ${servicesFile}`);
  }
  const baseUrl = process.env.STATUS_BASE_URL || config.baseUrl;
  const previous = await readJson(dataFile, null);
  const prevById = new Map((previous?.services ?? []).map((s) => [s.id, s]));

  const services = config.services.map((s) => ({
    ...s,
    // URL exibida na página: sempre a de produção configurada, nunca a de teste.
    displayUrl: new URL(s.path, config.baseUrl).toString(),
  }));

  const results = await Promise.all(
    services.map((s) => checkService(s, baseUrl, prevById.get(s.id) ?? {}))
  );
  const checksById = Object.fromEntries(services.map((s, i) => [s.id, results[i]]));

  const next = buildNextStatus(previous, services, checksById, new Date());

  await mkdir(path.dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 1) + "\n", "utf8");
  await rename(tmp, dataFile);

  for (const s of services) {
    const r = checksById[s.id];
    const detail = r.httpStatus ?? r.error;
    console.log(`${s.id.padEnd(10)} ${r.outcome.padEnd(8)} ${String(detail).padEnd(8)} ${r.latencyMs ?? "-"} ms`);
  }
  const open = next.incidents.filter((i) => i.endedAt == null).length;
  console.log(`gravado em ${dataFile} (incidentes abertos: ${open})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
