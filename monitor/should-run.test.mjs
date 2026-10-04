import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * A proteção de frescor existe pra vários gatilhos no mesmo intervalo não
 * virarem verificação e deploy em excesso. O detalhe que este arquivo trava:
 * `workflow_dispatch` era tratado como "alguém clicou" e SEMPRE verificava —
 * regra escrita quando disparo assim era mesmo manual. Com o agendador
 * externo (cron-job.org) usando o mesmo gatilho a cada poucos minutos, isso
 * furava a proteção: medido em produção, tiques com status de 69s ainda
 * verificavam. Agora só o disparo humano fura.
 */

const script = fileURLToPath(new URL("./should-run.mjs", import.meta.url));

function run(env, ageSeconds) {
  const dir = mkdtempSync(join(tmpdir(), "should-run-"));
  const file = join(dir, "status.json");
  const generatedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  writeFileSync(file, JSON.stringify({ generatedAt }));
  const out = execFileSync(process.execPath, [script, file], {
    env: { ...process.env, GITHUB_OUTPUT: "", ...env },
    encoding: "utf8",
  });
  return { saida: out.trim(), verificou: out.includes("verificando") };
}

describe("should-run", () => {
  it("pula quando o status é recente, no gatilho por push", () => {
    assert.equal(run({ GITHUB_EVENT_NAME: "push", DISPATCH_ORIGIN: "" }, 60).verificou, false);
  });

  it("verifica quando o status está velho, no gatilho por push", () => {
    assert.equal(run({ GITHUB_EVENT_NAME: "push", DISPATCH_ORIGIN: "" }, 600).verificou, true);
  });

  it("agendador externo RESPEITA o frescor (era o furo)", () => {
    const recente = run({ GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_ORIGIN: "cron-job.org" }, 69);
    assert.equal(recente.verificou, false, recente.saida);

    const velho = run({ GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_ORIGIN: "cron-job.org" }, 600);
    assert.equal(velho.verificou, true, velho.saida);
  });

  it("clique humano continua forçando a verificação", () => {
    assert.equal(run({ GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_ORIGIN: "manual" }, 10).verificou, true);
    // Sem `origem` (workflow antigo, ou quem chamou a API sem o campo).
    assert.equal(run({ GITHUB_EVENT_NAME: "workflow_dispatch", DISPATCH_ORIGIN: "" }, 10).verificou, true);
  });

  it("arquivo ausente ou ilegível sempre verifica", () => {
    const out = execFileSync(process.execPath, [script, join(tmpdir(), "nao-existe-status.json")], {
      env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_EVENT_NAME: "push" },
      encoding: "utf8",
    });
    assert.ok(out.includes("verificando"), out);
  });
});
