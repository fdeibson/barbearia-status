// Lógica pura compartilhada entre o monitor (Node, monitor/lib.mjs) e a
// página (navegador, assets/app.mjs). Sem I/O, sem dependências — por isso
// fica dentro de site/ (o navegador precisa conseguir importar) e o monitor
// importa daqui. Coberta pelos testes em monitor/lib.test.mjs.

export const TIME_ZONE = "America/Sao_Paulo";
export const WINDOW_DAYS = 90;
/** Acima disso (em minutos) sem verificação nova, o estado vira "Desconhecido". */
export const STALE_AFTER_MINUTES = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Data civil (YYYY-MM-DD) no fuso de Brasília para um instante. */
export function saoPauloDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Soma `delta` dias a uma data civil YYYY-MM-DD (aritmética de calendário, sem fuso). */
export function addDaysToKey(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** As `n` datas civis terminando em `todayKey` (inclusive), da mais antiga para a mais nova. */
export function lastNDayKeys(todayKey, n = WINDOW_DAYS) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(addDaysToKey(todayKey, -i));
  return keys;
}

/**
 * Verificações "determinadas" de um dia: up + degraded (respondeu) + down.
 * `unknown` não entra — não sabemos se estava no ar ou não.
 */
export function dayCounts(bucket) {
  const up = (bucket?.up ?? 0) + (bucket?.degraded ?? 0);
  const down = bucket?.down ?? 0;
  return { up, down, determinate: up + down };
}

/** % de disponibilidade de um dia, ou null quando não há verificação determinada. */
export function dayUptime(bucket) {
  const { up, determinate } = dayCounts(bucket);
  return determinate === 0 ? null : (up / determinate) * 100;
}

/**
 * Disponibilidade na janela: soma as verificações dos dias COM dados e
 * ignora os dias sem dados (nunca os trata como 100% nem como 0%).
 * Retorna { percent: number|null, daysWithData, days }.
 */
export function windowUptime(daily, dayKeys) {
  let up = 0;
  let determinate = 0;
  let daysWithData = 0;
  for (const key of dayKeys) {
    const c = dayCounts(daily?.[key]);
    if (c.determinate > 0) {
      daysWithData++;
      up += c.up;
      determinate += c.determinate;
    }
  }
  return {
    percent: determinate === 0 ? null : (up / determinate) * 100,
    daysWithData,
    days: dayKeys.length,
  };
}

/** Minutos desde `iso` até `now`; Infinity se ausente/inválido. */
export function ageMinutes(iso, now = new Date()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return Infinity;
  return (now.getTime() - t) / 60000;
}

export function isStale(iso, now = new Date(), limitMinutes = STALE_AFTER_MINUTES) {
  return ageMinutes(iso, now) > limitMinutes;
}

/**
 * Estado geral a partir dos estados atuais de cada serviço.
 * - dados ausentes/velhos → "unknown"
 * - todos os serviços conhecidos no ar → "operational" (serviços "unknown"
 *   não derrubam nem confirmam nada)
 * - todos os conhecidos fora → "outage"
 * - qualquer fora/lento → "degraded"
 */
export function overallState(data, now = new Date(), limitMinutes = STALE_AFTER_MINUTES) {
  if (!data || !Array.isArray(data.services) || data.services.length === 0) return "unknown";
  if (isStale(data.generatedAt, now, limitMinutes)) return "unknown";
  const states = data.services.map((s) =>
    s.current && !isStale(s.current.checkedAt, now, limitMinutes) ? s.current.state : "unknown"
  );
  const known = states.filter((s) => s !== "unknown");
  if (known.length === 0) return "unknown";
  if (known.every((s) => s === "down")) return "outage";
  if (known.some((s) => s === "down" || s === "degraded")) return "degraded";
  return "operational";
}

/** Duração legível em português ("2 h 5 min", "45 min", "menos de 1 min"). */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "menos de 1 min";
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days} d`);
  if (hours) parts.push(`${hours} h`);
  if (mins && !days) parts.push(`${mins} min`);
  return parts.join(" ");
}
