import { Agent } from "agents";

import type { Env } from "./env";
import {
  CLIENT_FOLLOW_UP_WINDOW_MS,
  CLIENT_INVESTIGATION_WINDOW_MS,
  decideFollowUpAdmission,
  decideInvestigationAdmission,
  fixedWindowStart,
  GLOBAL_FOLLOW_UP_WINDOW_MS,
  GLOBAL_INVESTIGATION_WINDOW_MS,
  READ_LIMIT,
  READ_WINDOW_MS,
  type RateLimitDecision,
  windowRetryAfterSeconds,
} from "./rate-limit-policy";

const ADMISSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

type CountRow = { count: number };

export class PublicRateLimitAgent extends Agent<Env, Record<string, never>> {
  initialState: Record<string, never> = {};

  async onStart(): Promise<void> {
    this.sql`
      CREATE TABLE IF NOT EXISTS rate_limit_buckets (
        scope TEXT NOT NULL,
        actor_key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (scope, actor_key, window_start)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS investigation_admissions (
        session_id TEXT PRIMARY KEY,
        admitted_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS follow_up_admissions (
        message_id TEXT PRIMARY KEY,
        admitted_at INTEGER NOT NULL
      )
    `;
  }

  async admitRead(
    clientKey: string,
    nowMs = Date.now(),
  ): Promise<RateLimitDecision> {
    this.requireKey(clientKey, "client_key");
    this.cleanup(nowMs);
    return this.consume(
      "read",
      clientKey,
      READ_LIMIT,
      READ_WINDOW_MS,
      nowMs,
    );
  }

  async admitInvestigation(
    clientKey: string,
    sessionId: string,
    nowMs = Date.now(),
  ): Promise<RateLimitDecision> {
    this.requireKey(clientKey, "client_key");
    this.requireKey(sessionId, "session_id");
    this.cleanup(nowMs);

    const existing = this.sql<{ admitted_at: number }>`
      SELECT admitted_at
      FROM investigation_admissions
      WHERE session_id = ${sessionId}
      LIMIT 1
    `;
    const clientWindow = fixedWindowStart(
      nowMs,
      CLIENT_INVESTIGATION_WINDOW_MS,
    );
    const globalWindow = fixedWindowStart(
      nowMs,
      GLOBAL_INVESTIGATION_WINDOW_MS,
    );
    const clientCount = this.getCount(
      "investigation-client",
      clientKey,
      clientWindow,
    );
    const globalCount = this.getCount(
      "investigation-global",
      "global",
      globalWindow,
    );

    const decision = decideInvestigationAdmission({
      duplicate: existing.length > 0,
      clientCount,
      globalCount,
      nowMs,
      clientWindowStart: clientWindow,
      globalWindowStart: globalWindow,
    });
    if (!decision.allowed || decision.duplicate) return decision;

    this.increment("investigation-client", clientKey, clientWindow);
    this.increment("investigation-global", "global", globalWindow);
    this.sql`
      INSERT INTO investigation_admissions (session_id, admitted_at)
      VALUES (${sessionId}, ${nowMs})
    `;
    return { allowed: true, duplicate: false, retryAfterSeconds: 0 };
  }

  async admitFollowUp(
    clientKey: string,
    messageId: string,
    nowMs = Date.now(),
  ): Promise<RateLimitDecision> {
    this.requireKey(clientKey, "client_key");
    this.requireKey(messageId, "message_id");
    this.cleanup(nowMs);

    const existing = this.sql<{ admitted_at: number }>`
      SELECT admitted_at
      FROM follow_up_admissions
      WHERE message_id = ${messageId}
      LIMIT 1
    `;
    const clientWindow = fixedWindowStart(nowMs, CLIENT_FOLLOW_UP_WINDOW_MS);
    const globalWindow = fixedWindowStart(nowMs, GLOBAL_FOLLOW_UP_WINDOW_MS);
    const clientCount = this.getCount("follow-up-client", clientKey, clientWindow);
    const globalCount = this.getCount("follow-up-global", "global", globalWindow);
    const decision = decideFollowUpAdmission({
      duplicate: existing.length > 0,
      clientCount,
      globalCount,
      nowMs,
      clientWindowStart: clientWindow,
      globalWindowStart: globalWindow,
    });
    if (!decision.allowed || decision.duplicate) return decision;

    this.increment("follow-up-client", clientKey, clientWindow);
    this.increment("follow-up-global", "global", globalWindow);
    this.sql`
      INSERT INTO follow_up_admissions (message_id, admitted_at)
      VALUES (${messageId}, ${nowMs})
    `;
    return { allowed: true, duplicate: false, retryAfterSeconds: 0 };
  }

  private consume(
    scope: string,
    actorKey: string,
    limit: number,
    windowMs: number,
    nowMs: number,
  ): RateLimitDecision {
    const windowStart = fixedWindowStart(nowMs, windowMs);
    if (this.getCount(scope, actorKey, windowStart) >= limit) {
      return {
        allowed: false,
        duplicate: false,
        retryAfterSeconds: windowRetryAfterSeconds(
          nowMs,
          windowStart,
          windowMs,
        ),
      };
    }
    this.increment(scope, actorKey, windowStart);
    return { allowed: true, duplicate: false, retryAfterSeconds: 0 };
  }

  private getCount(
    scope: string,
    actorKey: string,
    windowStart: number,
  ): number {
    const rows = this.sql<CountRow>`
      SELECT count
      FROM rate_limit_buckets
      WHERE scope = ${scope}
        AND actor_key = ${actorKey}
        AND window_start = ${windowStart}
      LIMIT 1
    `;
    return rows[0]?.count ?? 0;
  }

  private increment(scope: string, actorKey: string, windowStart: number): void {
    this.sql`
      INSERT INTO rate_limit_buckets (scope, actor_key, window_start, count)
      VALUES (${scope}, ${actorKey}, ${windowStart}, 1)
      ON CONFLICT(scope, actor_key, window_start)
      DO UPDATE SET count = count + 1
    `;
  }

  private cleanup(nowMs: number): void {
    const oldestBucket = nowMs - Math.max(
      GLOBAL_INVESTIGATION_WINDOW_MS,
      GLOBAL_FOLLOW_UP_WINDOW_MS,
    );
    const oldestAdmission = nowMs - ADMISSION_RETENTION_MS;
    this.sql`DELETE FROM rate_limit_buckets WHERE window_start < ${oldestBucket}`;
    this.sql`DELETE FROM investigation_admissions WHERE admitted_at < ${oldestAdmission}`;
    this.sql`DELETE FROM follow_up_admissions WHERE admitted_at < ${oldestAdmission}`;
  }

  private requireKey(value: string, field: string): void {
    if (!KEY_PATTERN.test(value)) {
      throw new Error(`invalid_${field}`);
    }
  }
}
