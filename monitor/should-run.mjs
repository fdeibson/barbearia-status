#!/usr/bin/env node
// Decide se a rodada do monitor precisa verificar agora. Vários gatilhos
// (agendador do GitHub, push na branch `tick` vindo de agendadores externos)
// podem cair no mesmo intervalo: se o status publicado tem menos de
// MIN_INTERVAL_SECONDS, pula — sem verificação nem deploy em excesso.
// Disparo manual (workflow_dispatch) sempre verifica.
//
// Uso: node monitor/should-run.mjs site/data/status.json   (grava run=true|false em $GITHUB_OUTPUT)
import { appendFileSync, readFileSync } from "node:fs";

const MIN_INTERVAL_SECONDS = Number(process.env.MIN_INTERVAL_SECONDS ?? 240);
const file = process.argv[2] ?? "site/data/status.json";

let ageSeconds = Infinity;
try {
  ageSeconds = (Date.now() - Date.parse(JSON.parse(readFileSync(file, "utf8")).generatedAt)) / 1000;
} catch {
  // sem arquivo/ilegível: verifica
}
const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const run = manual || !(ageSeconds < MIN_INTERVAL_SECONDS);
console.log(`status publicado há ${Number.isFinite(ageSeconds) ? Math.round(ageSeconds) + "s" : "?"} — ${run ? "verificando" : "recente, pulando"}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
