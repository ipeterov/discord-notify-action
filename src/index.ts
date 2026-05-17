import * as core from "@actions/core";
import { setTimeout as sleep } from "node:timers/promises";

import { DiscordClient } from "./discord.js";
import { GitHubClient } from "./github.js";
import type { Job } from "./github.js";
import { parseJobsInput } from "./inputs.js";
import { matchJobs } from "./match.js";
import { allRowsTerminal, failedWatched, renderEmbed } from "./render.js";
import type { WatchedJob } from "./render.js";
import { parseWorkflow } from "./workflow.js";
import type { JobMeta } from "./workflow.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_DURATION_MS = 6 * 60 * 60 * 1_000;

async function main(): Promise<void> {
  const webhook = core.getInput("webhook", { required: true });
  const jobsInput = core.getInput("jobs", { required: true });
  const watchedIds = parseJobsInput(jobsInput);
  const token =
    core.getInput("github-token") || process.env.GITHUB_TOKEN || "";

  const repo = requireEnv("GITHUB_REPOSITORY");
  const runId = requireEnv("GITHUB_RUN_ID");

  core.setSecret(webhook);

  const gh = new GitHubClient(token);
  const discord = new DiscordClient(webhook);

  try {
    const runPromise = gh.fetchRun(repo, runId);
    const jobsPromise = gh.fetchJobs(repo, runId);
    const workflowPromise = runPromise.then((run) =>
      gh.fetchWorkflowFile(repo, run.path, run.head_sha),
    );

    const [run, jobs, workflowYaml] = await Promise.all([
      runPromise,
      jobsPromise,
      workflowPromise,
    ]);

    const meta = parseWorkflow(workflowYaml);
    validateIds(watchedIds, meta);
    warnDynamicNames(watchedIds, meta);

    const watched = buildWatched(watchedIds, meta, jobs);
    const embed = renderEmbed(watched, run, repo);
    const messageId = await discord.post(embed);

    let lastPayload = JSON.stringify(embed);
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (Date.now() < deadline) {
      if (watched.every(allRowsTerminal)) {
        reportWatchedFailures(watched);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      const [nextRun, nextJobs] = await Promise.all([
        gh.fetchRun(repo, runId),
        gh.fetchJobs(repo, runId),
      ]);
      const nextWatched = buildWatched(watchedIds, meta, nextJobs);
      const nextEmbed = renderEmbed(nextWatched, nextRun, repo);
      const nextPayload = JSON.stringify(nextEmbed);
      if (nextPayload !== lastPayload) {
        await discord.patch(messageId, nextEmbed);
        lastPayload = nextPayload;
      }
      watched.splice(0, watched.length, ...nextWatched);
    }

    core.setFailed("Notify Discord: poll deadline exceeded");
  } finally {
    await Promise.all([gh.close(), discord.close()]);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function validateIds(ids: string[], meta: Map<string, JobMeta>): void {
  const missing = ids.filter((id) => !meta.has(id));
  if (missing.length > 0) {
    const known = [...meta.keys()].join(", ");
    throw new Error(
      `Unknown job id(s): ${missing.join(", ")}. Known ids in this workflow: ${known}`,
    );
  }
}

function warnDynamicNames(ids: string[], meta: Map<string, JobMeta>): void {
  for (const id of ids) {
    const m = meta.get(id);
    if (m?.dynamicName) {
      core.warning(
        `Job '${id}' uses expression syntax in its name (\`${m.label} …\`). ` +
          `Matching will use the static prefix '${m.label}'; verify the card looks right.`,
      );
    }
  }
}

function reportWatchedFailures(watched: WatchedJob[]): void {
  const failed = failedWatched(watched);
  if (failed.length === 0) return;
  const ids = failed.map((w) => w.id).join(", ");
  core.setFailed(`Watched job(s) failed: ${ids}`);
}

function buildWatched(
  ids: string[],
  meta: Map<string, JobMeta>,
  jobs: Job[],
): WatchedJob[] {
  return ids.map((id) => {
    const m = meta.get(id)!;
    const rows = matchJobs(m, jobs);
    return { id, label: m.label, rows, multi: m.multi };
  });
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
