import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Job, Run } from "../src/github.js";
import { renderEmbed } from "../src/render.js";
import type { Embed, WatchedJob } from "../src/render.js";

function fakeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    run_number: 42,
    run_attempt: 1,
    html_url: "https://github.com/o/r/actions/runs/1",
    head_branch: "main",
    head_sha: "abcdef1234567",
    path: ".github/workflows/ci.yml",
    status: "in_progress",
    conclusion: null,
    triggering_actor: { login: "octocat" },
    head_commit: { message: "fix the build", author: { name: "Octo Cat" } },
    ...overrides,
  };
}

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    name: "Tests",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/o/r/actions/runs/1/job/1",
    started_at: "2024-01-01T00:00:00Z",
    completed_at: "2024-01-01T00:01:30Z",
    labels: [],
    ...overrides,
  };
}

function watched(rows: Job[], label = "Tests", multi = false): WatchedJob {
  return { id: "tests", label, rows, multi };
}

/** All visible text in the embed (title, fields, footer), for substring asserts. */
function allText(embed: Embed): string {
  return JSON.stringify(embed);
}

/** The single field rendered for a one-job `watched`, as `name`/`value`. */
function onlyField(embed: Embed): { name: string; value: string } {
  assert.equal(embed.fields.length, 1, "expected exactly one field");
  return embed.fields[0]!;
}

describe("renderEmbed (Discord)", () => {
  it("emits a color and at least one field", () => {
    const embed = renderEmbed([watched([fakeJob()])], fakeRun(), "o/r");
    assert.equal(embed.color, 0x57ab5a); // all-success
    assert.ok(Array.isArray(embed.fields) && embed.fields.length > 0);
  });

  it("title carries repo, branch, and run number", () => {
    const embed = renderEmbed([watched([fakeJob()])], fakeRun(), "octo/repo");
    assert.ok(embed.title.includes("repo")); // repoShort, for multi-repo channels
    assert.ok(embed.title.includes("main")); // branch
    assert.ok(embed.title.includes("run #42"));
  });

  it("uses GitHub's run number in the title by default", () => {
    const embed = renderEmbed([watched([fakeJob()])], fakeRun(), "o/r");
    assert.ok(embed.title.includes("run #42"));
  });

  it("overrides the title with a caller-supplied build number", () => {
    const embed = renderEmbed(
      [watched([fakeJob()])],
      fakeRun(),
      "o/r",
      false,
      "6128",
    );
    const text = allText(embed);
    assert.ok(text.includes("build #6128"));
    assert.ok(!text.includes("run #42"));
  });

  it("appends an attempt suffix on re-runs", () => {
    const embed = renderEmbed(
      [watched([fakeJob()])],
      fakeRun({ run_attempt: 2 }),
      "o/r",
    );
    assert.ok(embed.title.includes("(attempt 2)"));
  });

  it("freezes a completed job's duration regardless of `now`", () => {
    // completed job: 00:00:00 → 00:01:30 = 1m 30s.
    const field = onlyField(renderEmbed([watched([fakeJob()])], fakeRun(), "o/r"));
    assert.ok(field.value.includes("1m 30s"), field.value);
  });

  it("shows `running` for an in-progress job", () => {
    const job = fakeJob({
      status: "in_progress",
      conclusion: null,
      started_at: new Date(Date.now() - 65_000).toISOString(),
      completed_at: null,
    });
    const field = onlyField(renderEmbed([watched([job])], fakeRun(), "o/r"));
    assert.ok(field.value.includes("running"), field.value);
  });

  it("links the job to its logs", () => {
    const field = onlyField(
      renderEmbed([watched([fakeJob()], "Linters")], fakeRun(), "o/r"),
    );
    assert.equal(field.name, "✅ Linters");
    assert.ok(field.value.includes("[logs ↗](https://github.com/o/r/actions/runs/1/job/1)"));
  });

  it("footer pairs the card to the push: sha · author · subject", () => {
    const embed = renderEmbed([watched([fakeJob()])], fakeRun(), "o/r");
    const text = embed.footer?.text ?? "";
    assert.ok(text.includes("abcdef1")); // short sha
    assert.ok(text.includes("Octo Cat")); // author
    assert.ok(text.includes("fix the build")); // subject
  });

  it("does not enable mentions (handled by the Discord client, not render)", () => {
    // Discord suppresses pings via `allowed_mentions: { parse: [] }` on the
    // webhook payload, so render passes commit/job text through verbatim.
    const run = fakeRun({
      head_commit: { message: "@everyone ping", author: { name: "x" } },
    });
    const embed = renderEmbed([watched([fakeJob()], "Linters")], run, "o/r");
    assert.ok(embed.footer?.text?.includes("@everyone ping"));
  });

  it("renders a failure color when a watched job fails", () => {
    const embed = renderEmbed(
      [watched([fakeJob({ conclusion: "failure" })])],
      fakeRun(),
      "o/r",
    );
    assert.equal(embed.color, 0xe5534b);
  });

  it("shows the conclusion word for a skipped job, not `done`", () => {
    const job = fakeJob({
      conclusion: "skipped",
      started_at: null,
      completed_at: null,
    });
    const field = onlyField(renderEmbed([watched([job], "Build")], fakeRun(), "o/r"));
    assert.ok(field.value.includes("skipped"), field.value);
    assert.ok(!field.value.includes("done"), field.value);
  });

  it("shows the conclusion word alongside the duration for a success", () => {
    // Decoded for every conclusion, not just the non-success ones.
    const field = onlyField(renderEmbed([watched([fakeJob()], "Tests")], fakeRun(), "o/r"));
    assert.ok(field.value.includes("success"), field.value);
    assert.ok(field.value.includes("1m 30s"), field.value);
  });

  it("decodes a cancelled job's conclusion", () => {
    const job = fakeJob({ conclusion: "cancelled" });
    const field = onlyField(renderEmbed([watched([job], "Deploy")], fakeRun(), "o/r"));
    assert.ok(field.value.includes("cancelled"), field.value);
  });

  it("a fully-done matrix reads `N jobs done`, not `combos`", () => {
    const rows = [
      fakeJob({ name: "Tests (a)" }),
      fakeJob({ name: "Tests (b)" }),
      fakeJob({ name: "Tests (c)" }),
    ];
    const field = onlyField(
      renderEmbed([watched(rows, "Tests", true)], fakeRun(), "o/r"),
    );
    assert.ok(field.value.includes("3 jobs done"), field.value);
    assert.ok(!field.value.includes("combos"), field.value);
  });

  it("matrix collapse: shows runtime and a per-combo count", () => {
    const rows = [
      fakeJob({ name: "Tests (3.11)" }),
      fakeJob({ name: "Tests (3.12)" }),
      fakeJob({ name: "Tests (3.13)" }),
    ];
    const field = onlyField(
      renderEmbed([watched(rows, "Tests", true)], fakeRun(), "o/r"),
    );
    assert.ok(field.value.includes("1m 30s")); // fakeJob default duration
  });

  it("matrix runtime spans earliest start → latest finish when done", () => {
    const rows = [
      fakeJob({
        name: "Tests (a)",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:02:00Z",
      }),
      fakeJob({
        name: "Tests (b)",
        started_at: "2024-01-01T00:00:30Z",
        completed_at: "2024-01-01T00:03:30Z",
      }),
    ];
    const field = onlyField(
      renderEmbed([watched(rows, "Tests", true)], fakeRun(), "o/r"),
    );
    assert.ok(field.value.includes("3m 30s"), field.value);
  });

  it("reports a partial matrix with a done/total count and failures", () => {
    const rows = [
      fakeJob({ name: "Tests (a)" }),
      fakeJob({ name: "Tests (b)", conclusion: "failure" }),
      fakeJob({
        name: "Tests (c)",
        status: "in_progress",
        conclusion: null,
        completed_at: null,
      }),
    ];
    const field = onlyField(
      renderEmbed([watched(rows, "Tests", true)], fakeRun(), "o/r"),
    );
    assert.ok(field.value.includes("2/3 done"), field.value);
    assert.ok(field.value.includes("1 failed"), field.value);
  });

  it("shows a waiting placeholder for a watched job not yet in the API", () => {
    const field = onlyField(
      renderEmbed([watched([], "Deploy")], fakeRun(), "o/r"),
    );
    assert.equal(field.name, "⏳ Deploy");
    assert.equal(field.value, "waiting");
  });

  it("shows a monitoring-stopped notice and error color", () => {
    const embed = renderEmbed([watched([fakeJob()])], fakeRun(), "o/r", true);
    assert.equal(embed.color, 0x8957e5);
    assert.ok(allText(embed).includes("Monitoring stopped"));
  });
});
