import { Pool } from "undici";

export interface Run {
  id: number;
  run_number: number;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  path: string;
  status: string | null;
  conclusion: string | null;
  triggering_actor: { login: string } | null;
  head_commit: {
    message: string | null;
    author: { name: string | null } | null;
  } | null;
}

export interface Job {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  labels: string[];
}

export class GitHubClient {
  private pool: Pool;
  private headers: Record<string, string>;

  constructor(token: string) {
    this.pool = new Pool("https://api.github.com", {
      connections: 4,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
    this.headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ipeterov/discord-notify-action",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.pool.request({
      method: "GET",
      path,
      headers: this.headers,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`GitHub ${path} → ${res.statusCode}: ${body}`);
    }
    return (await res.body.json()) as T;
  }

  fetchRun(repo: string, runId: string): Promise<Run> {
    return this.get<Run>(`/repos/${repo}/actions/runs/${runId}`);
  }

  async fetchJobs(repo: string, runId: string): Promise<Job[]> {
    const jobs: Job[] = [];
    let page = 1;
    while (true) {
      const data = await this.get<{ jobs: Job[]; total_count: number }>(
        `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      );
      jobs.push(...data.jobs);
      if (jobs.length >= data.total_count) break;
      page += 1;
    }
    return jobs;
  }

  async fetchWorkflowFile(
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    const data = await this.get<{ content: string; encoding: string }>(
      `/repos/${repo}/contents/${path}?ref=${ref}`,
    );
    if (data.encoding !== "base64") {
      throw new Error(`Unexpected content encoding: ${data.encoding}`);
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  }
}
