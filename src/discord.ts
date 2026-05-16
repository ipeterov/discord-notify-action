import { Pool } from "undici";
import type { Embed } from "./render.js";

// Match GitHub's `/github` integration username so messages group with
// its commit notifications. Avatar inherits from the webhook's config.
const IDENTITY = { username: "GitHub" };

// Defensive: a commit subject like "@here fix the build" must not actually
// ping the channel.
const ALLOWED_MENTIONS = { parse: [] as string[] };

export class DiscordClient {
  private pool: Pool;
  private webhookPath: string;
  private headers: Record<string, string>;

  constructor(webhookUrl: string) {
    const url = new URL(webhookUrl);
    this.pool = new Pool(`${url.protocol}//${url.host}`, {
      connections: 2,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
    this.webhookPath = url.pathname;
    this.headers = {
      "Content-Type": "application/json",
      "User-Agent": "ipeterov/discord-notify-action",
    };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  async post(embed: Embed): Promise<string> {
    const res = await this.pool.request({
      method: "POST",
      path: `${this.webhookPath}?wait=true`,
      headers: this.headers,
      body: JSON.stringify({
        ...IDENTITY,
        embeds: [embed],
        allowed_mentions: ALLOWED_MENTIONS,
      }),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`Discord POST → ${res.statusCode}: ${body}`);
    }
    const data = (await res.body.json()) as { id: string };
    return data.id;
  }

  async patch(messageId: string, embed: Embed): Promise<void> {
    const res = await this.pool.request({
      method: "PATCH",
      path: `${this.webhookPath}/messages/${messageId}`,
      headers: this.headers,
      body: JSON.stringify({
        embeds: [embed],
        allowed_mentions: ALLOWED_MENTIONS,
      }),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const body = await res.body.text();
      throw new Error(`Discord PATCH → ${res.statusCode}: ${body}`);
    }
    await res.body.dump();
  }
}
