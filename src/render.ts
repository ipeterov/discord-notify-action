import type { Job, Run } from "./github.js";

const STATE_EMOJI: Record<string, string> = {
  "queued|": "🅿️",
  "pending|": "🅿️",
  "waiting|": "⏳",
  "in_progress|": "⚙️",
  "completed|success": "✅",
  "completed|failure": "❌",
  "completed|cancelled": "🚫",
  "completed|skipped": "⏭️",
  "completed|timed_out": "⏱️",
  "completed|action_required": "⚠️",
  "completed|neutral": "⚪",
  "completed|stale": "🪦",
};
const UNKNOWN_EMOJI = "❓";
// A watched job we don't yet see in the API. Almost always because it has
// `needs:` on a job that hasn't finished yet, so GitHub hasn't materialized
// the row. Semantically "waiting".
const MISSING_EMOJI = "⏳";

const TERMINAL_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
]);

const COLOR_RUNNING = 0xc69026;
const COLOR_SUCCESS = 0x57ab5a;
const COLOR_FAILURE = 0xe5534b;
const COLOR_CANCELLED = 0x9198a1;
const COLOR_ERROR = 0x8957e5;

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title: string;
  url?: string;
  color: number;
  fields: EmbedField[];
  description?: string;
  footer?: { text: string };
}

export interface WatchedJob {
  id: string;
  label: string;
  rows: Job[];
  multi: boolean;
}

export function pickEmoji(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): string {
  if (!status) return MISSING_EMOJI;
  if (status === "completed") {
    return STATE_EMOJI[`completed|${conclusion ?? ""}`] ?? UNKNOWN_EMOJI;
  }
  return STATE_EMOJI[`${status}|`] ?? UNKNOWN_EMOJI;
}

export function isTerminal(job: Job): boolean {
  if (job.status !== "completed") return false;
  return job.conclusion !== null && TERMINAL_CONCLUSIONS.has(job.conclusion);
}

export function allRowsTerminal(w: WatchedJob): boolean {
  if (w.rows.length === 0) return false;
  return w.rows.every(isTerminal);
}

const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out"]);

export function failedWatched(watched: WatchedJob[]): WatchedJob[] {
  return watched.filter((w) =>
    w.rows.some(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== null &&
        FAILURE_CONCLUSIONS.has(r.conclusion),
    ),
  );
}

function aggregateState(rows: Job[]): {
  status: string | null;
  conclusion: string | null;
} {
  if (rows.length === 0) return { status: null, conclusion: null };
  if (rows.some((r) => r.status === "completed" && r.conclusion === "failure")) {
    return { status: "completed", conclusion: "failure" };
  }
  if (rows.every((r) => r.status === "completed")) {
    if (rows.some((r) => r.conclusion === "cancelled")) {
      return { status: "completed", conclusion: "cancelled" };
    }
    return { status: "completed", conclusion: "success" };
  }
  return { status: "in_progress", conclusion: null };
}

function unixSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function durationBetween(startIso: string | null, endIso: string | null): string | null {
  const s = unixSeconds(startIso);
  const e = unixSeconds(endIso);
  if (s === null || e === null || e < s) return null;
  return formatDuration(e - s);
}

/** Earliest non-null start timestamp across rows, as unix seconds. */
function earliestStart(rows: Job[]): number | null {
  let earliest: number | null = null;
  for (const r of rows) {
    const t = unixSeconds(r.started_at);
    if (t !== null && (earliest === null || t < earliest)) earliest = t;
  }
  return earliest;
}

/** Latest non-null completion timestamp across rows, as unix seconds. */
function latestCompletion(rows: Job[]): number | null {
  let latest: number | null = null;
  for (const r of rows) {
    const t = unixSeconds(r.completed_at);
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

function renderField(w: WatchedJob, runUrl: string): EmbedField {
  if (w.rows.length === 0) {
    return {
      name: `${MISSING_EMOJI} ${w.label}`,
      value: "waiting",
    };
  }

  if (w.rows.length === 1 && !w.multi) {
    const r = w.rows[0]!;
    const emoji = pickEmoji(r.status, r.conclusion);
    const url = r.html_url ?? runUrl;
    return {
      name: `${emoji} ${w.label}`,
      value: rowDetail(r, url),
    };
  }

  // Collapsed multi-row (matrix or reusable workflow).
  const agg = aggregateState(w.rows);
  const emoji = pickEmoji(agg.status, agg.conclusion);
  const done = w.rows.filter((r) => r.status === "completed").length;
  const failed = w.rows.filter(
    (r) => r.status === "completed" && r.conclusion === "failure",
  ).length;
  const total = w.rows.length;
  let summary: string;
  if (failed > 0) {
    summary = `${done}/${total} done, ${failed} failed`;
  } else if (done < total) {
    summary = `${done}/${total} done`;
  } else {
    summary = `${total} combos`;
  }
  return {
    name: `${emoji} ${w.label}`,
    value: matrixDetail(w.rows, summary, runUrl),
  };
}

function rowDetail(job: Job, url: string): string {
  const bits: string[] = [];
  if (job.status === "completed") {
    const d = durationBetween(job.started_at, job.completed_at);
    if (d) bits.push(d);
  } else if (job.status === "in_progress") {
    bits.push("running");
  } else {
    bits.push(humanStatus(job.status));
  }
  bits.push(`[logs ↗](${url})`);
  return bits.join("  ·  ");
}

function matrixDetail(rows: Job[], summary: string, runUrl: string): string {
  const bits: string[] = [summary];
  const allDone = rows.every((r) => r.status === "completed");
  if (allDone) {
    const earliest = earliestStart(rows);
    const latest = latestCompletion(rows);
    if (earliest !== null && latest !== null && latest >= earliest) {
      bits.push(formatDuration(latest - earliest));
    }
  }
  bits.push(`[logs ↗](${runUrl})`);
  return bits.join("  ·  ");
}

function humanStatus(status: string | null): string {
  if (!status) return "pending";
  if (status === "queued") return "queued";
  if (status === "waiting") return "waiting";
  if (status === "pending") return "pending";
  return status;
}

function overallColor(watched: WatchedJob[]): number {
  const aggs = watched.map((w) => aggregateState(w.rows));
  if (aggs.some((a) => a.status === "completed" && a.conclusion === "failure")) {
    return COLOR_FAILURE;
  }
  if (watched.every((w) => allRowsTerminal(w))) {
    if (aggs.some((a) => a.conclusion === "cancelled")) return COLOR_CANCELLED;
    return COLOR_SUCCESS;
  }
  return COLOR_RUNNING;
}

export function renderEmbed(
  watched: WatchedJob[],
  run: Run,
  repo: string,
  monitoringError?: boolean,
  buildNumber?: string,
): Embed {
  const sha = (run.head_sha ?? "").slice(0, 7);
  const branch = run.head_branch ?? "?";
  const repoShort = repo.split("/").pop() ?? repo;
  const subject = run.head_commit?.message?.split("\n")[0] ?? "";
  const author =
    run.head_commit?.author?.name ??
    run.triggering_actor?.login ??
    null;

  const attemptSuffix = run.run_attempt > 1 ? ` (attempt ${run.run_attempt})` : "";
  // A caller-supplied `build_number` overrides GitHub's run number (labelled
  // `build #` rather than `run #`); otherwise we fall back to the run number.
  const numberPart = buildNumber
    ? `build #${buildNumber}`
    : `run #${run.run_number}`;
  const title = `[${repoShort}:${branch}] CI · ${numberPart}${attemptSuffix}`.slice(0, 256);

  const earliest = earliestStart(watched.flatMap((w) => w.rows));
  const description =
    earliest !== null ? `started <t:${earliest}:R>` : undefined;

  const footerBits = [sha, author, subject].filter(
    (b): b is string => !!b && b.length > 0,
  );
  const footer = footerBits.length > 0
    ? { text: footerBits.join(" · ") }
    : undefined;

  // The monitoring-failure notice gets its own field so Discord renders it as a
  // separated block instead of crowding the `started …` line in the description.
  const errorField: EmbedField | null = monitoringError
    ? {
        name: "⚠️ Monitoring stopped",
        value:
          "The GitHub API kept failing, so this card may be out of date. Check the run directly.",
      }
    : null;

  const fields = [
    ...(errorField ? [errorField] : []),
    ...watched.map((w) => renderField(w, run.html_url)),
  ];

  return {
    title,
    url: run.html_url,
    color: monitoringError ? COLOR_ERROR : overallColor(watched),
    description,
    fields,
    footer,
  };
}
