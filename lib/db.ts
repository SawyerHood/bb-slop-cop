// Persistence. Migrations are append-only by statement index — never reorder
// or edit a shipped statement, only push new ones.
import type {
  Rule,
  Run,
  RunComment,
  RunStatus,
  Condition,
  Trigger,
  ThreadRequest,
} from "./types";

// The plugin SDK's database handle is better-sqlite3; typed structurally so
// this module stays unit-testable without importing the driver.
export interface Database {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS rules (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     repo TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     mode TEXT NOT NULL DEFAULT 'shadow',
     triggers TEXT NOT NULL,
     conditions TEXT NOT NULL,
     author_trust TEXT NOT NULL DEFAULT 'write_access',
     prompt TEXT NOT NULL DEFAULT '',
     request TEXT,
     dedupe TEXT NOT NULL DEFAULT 'once_per_pr',
     review_strategy TEXT NOT NULL DEFAULT 'update',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     rule_id TEXT NOT NULL,
     rule_name TEXT NOT NULL,
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     pr_title TEXT NOT NULL DEFAULT '',
     pr_author TEXT NOT NULL DEFAULT '',
     head_sha TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     mode TEXT NOT NULL DEFAULT 'shadow',
     detail TEXT,
     thread_id TEXT,
     comment_count INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER NOT NULL,
     finished_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS run_comments (
     run_id TEXT NOT NULL,
     github_id TEXT,
     kind TEXT NOT NULL,
     path TEXT,
     line INTEGER,
     url TEXT,
     body_excerpt TEXT NOT NULL DEFAULT '',
     attribution TEXT NOT NULL DEFAULT 'marker'
   )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_rule ON runs(rule_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_pr ON runs(repo, pr_number)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_run ON run_comments(run_id)`,
  // Seen-PR cursor: distinguishes "newly ready" from "was already ready when
  // the rule was created", so enabling a rule does not review the backlog.
  `CREATE TABLE IF NOT EXISTS seen_prs (
     repo TEXT NOT NULL,
     pr_number INTEGER NOT NULL,
     head_sha TEXT NOT NULL,
     was_draft INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (repo, pr_number)
   )`,
  // APPEND ONLY, and never renumber. Migrations are keyed by statement INDEX,
  // so an inserted statement inherits an already-applied index and is silently
  // skipped — which happened twice while adding `visibility` below. Both slots
  // it briefly occupied are now burned on existing installs, so it lives at the
  // end and everything before it must stay put.
  `CREATE INDEX IF NOT EXISTS idx_rules_repo ON rules(repo)`,
  `ALTER TABLE rules ADD COLUMN visibility TEXT NOT NULL DEFAULT 'visible'`,
  // Per-repo backlog watermark. Without this, "first sighting is not a trigger"
  // cannot distinguish a PR that predates watching from one just opened.
  `CREATE TABLE IF NOT EXISTS watched_repos (
     repo TEXT PRIMARY KEY,
     bootstrapped_at INTEGER NOT NULL
   )`,
  `ALTER TABLE runs ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'pull_request'`,
  `CREATE TABLE IF NOT EXISTS seen_issues (
     repo TEXT NOT NULL,
     issue_number INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (repo, issue_number)
   )`,
  `CREATE TABLE IF NOT EXISTS watched_issue_repos (
     repo TEXT PRIMARY KEY,
     bootstrapped_at INTEGER NOT NULL
   )`,
];

type Row = Record<string, unknown>;

function text(row: Row, key: string, fallback = ""): string {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
}
function num(row: Row, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === "number" ? value : fallback;
}
function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToRule(row: Row): Rule {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    repo: text(row, "repo"),
    enabled: num(row, "enabled") === 1,
    mode: text(row, "mode", "shadow") === "live" ? "live" : "shadow",
    triggers: parseJson<Trigger[]>(row.triggers, ["ready_for_review"]),
    conditions: parseJson<Condition[]>(row.conditions, []),
    authorTrust: text(row, "author_trust", "write_access") as Rule["authorTrust"],
    prompt: text(row, "prompt"),
    request: parseJson<ThreadRequest | null>(row.request, null),
    dedupe: text(row, "dedupe", "once_per_pr") as Rule["dedupe"],
    reviewStrategy: text(
      row,
      "review_strategy",
      "update",
    ) as Rule["reviewStrategy"],
    visibility: text(row, "visibility", "visible") === "hidden"
      ? "hidden"
      : "visible",
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export function rowToRun(row: Row): Run {
  return {
    id: text(row, "id"),
    ruleId: text(row, "rule_id"),
    ruleName: text(row, "rule_name"),
    repo: text(row, "repo"),
    targetKind:
      text(row, "target_kind", "pull_request") === "issue"
        ? "issue"
        : "pull_request",
    prNumber: num(row, "pr_number"),
    prTitle: text(row, "pr_title"),
    prAuthor: text(row, "pr_author"),
    headSha: text(row, "head_sha"),
    status: text(row, "status", "dispatched") as RunStatus,
    mode: text(row, "mode", "shadow") === "live" ? "live" : "shadow",
    detail: typeof row.detail === "string" ? row.detail : null,
    threadId: typeof row.thread_id === "string" ? row.thread_id : null,
    commentCount: num(row, "comment_count"),
    startedAt: num(row, "started_at"),
    finishedAt: typeof row.finished_at === "number" ? row.finished_at : null,
  };
}

export function createStore(db: Database) {
  return {
    listRules(): Rule[] {
      return (db.prepare(`SELECT * FROM rules ORDER BY name`).all() as Row[]).map(
        rowToRule,
      );
    },

    getRule(id: string): Rule | null {
      const row = db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as
        | Row
        | undefined;
      return row === undefined ? null : rowToRule(row);
    },

    findRuleByName(name: string): Rule | null {
      const row = db.prepare(`SELECT * FROM rules WHERE name = ?`).get(name) as
        | Row
        | undefined;
      return row === undefined ? null : rowToRule(row);
    },

    upsertRule(rule: Rule): void {
      db.prepare(
        `INSERT INTO rules (id, name, repo, enabled, mode, triggers, conditions,
           author_trust, prompt, request, dedupe, review_strategy, visibility,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, repo = excluded.repo, enabled = excluded.enabled,
           mode = excluded.mode, triggers = excluded.triggers,
           conditions = excluded.conditions, author_trust = excluded.author_trust,
           prompt = excluded.prompt, request = excluded.request,
           dedupe = excluded.dedupe, review_strategy = excluded.review_strategy,
           visibility = excluded.visibility, updated_at = excluded.updated_at`,
      ).run(
        rule.id,
        rule.name,
        rule.repo,
        rule.enabled ? 1 : 0,
        rule.mode,
        JSON.stringify(rule.triggers),
        JSON.stringify(rule.conditions),
        rule.authorTrust,
        rule.prompt,
        rule.request === null ? null : JSON.stringify(rule.request),
        rule.dedupe,
        rule.reviewStrategy,
        rule.visibility,
        rule.createdAt,
        rule.updatedAt,
      );
    },

    deleteRule(id: string): void {
      db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
    },

    listRuns(options: { ruleId?: string; limit?: number } = {}): Run[] {
      const limit = options.limit ?? 50;
      const rows =
        options.ruleId === undefined
          ? db
              .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
              .all(limit)
          : db
              .prepare(
                `SELECT * FROM runs WHERE rule_id = ? ORDER BY started_at DESC LIMIT ?`,
              )
              .all(options.ruleId, limit);
      return (rows as Row[]).map(rowToRun);
    },

    getRun(id: string): Run | null {
      const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
        | Row
        | undefined;
      return row === undefined ? null : rowToRun(row);
    },

    insertRun(run: Run): void {
      db.prepare(
        `INSERT INTO runs (id, rule_id, rule_name, repo, target_kind, pr_number, pr_title,
           pr_author, head_sha, status, mode, detail, thread_id, comment_count,
           started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.ruleId,
        run.ruleName,
        run.repo,
        run.targetKind,
        run.prNumber,
        run.prTitle,
        run.prAuthor,
        run.headSha,
        run.status,
        run.mode,
        run.detail,
        run.threadId,
        run.commentCount,
        run.startedAt,
        run.finishedAt,
      );
    },

    updateRun(
      id: string,
      patch: Partial<
        Pick<
          Run,
          "status" | "detail" | "threadId" | "commentCount" | "finishedAt"
        >
      >,
    ): void {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.detail !== undefined) {
        sets.push("detail = ?");
        params.push(patch.detail);
      }
      if (patch.threadId !== undefined) {
        sets.push("thread_id = ?");
        params.push(patch.threadId);
      }
      if (patch.commentCount !== undefined) {
        sets.push("comment_count = ?");
        params.push(patch.commentCount);
      }
      if (patch.finishedAt !== undefined) {
        sets.push("finished_at = ?");
        params.push(patch.finishedAt);
      }
      if (sets.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(
        ...params,
      );
    },

    findRunByThread(threadId: string): Run | null {
      const row = db
        .prepare(`SELECT * FROM runs WHERE thread_id = ?`)
        .get(threadId) as Row | undefined;
      return row === undefined ? null : rowToRun(row);
    },

    /** Dedupe: has this rule already run for this target or exact PR commit? */
    hasRunFor(
      ruleId: string,
      repo: string,
      targetKind: Run["targetKind"],
      prNumber: number,
      headSha: string | null,
    ): boolean {
      const row =
        headSha === null
          ? db
              .prepare(
                `SELECT 1 AS hit FROM runs
                 WHERE rule_id = ? AND repo = ? AND pr_number = ?
                   AND target_kind = ?
                   AND status NOT IN ('skipped', 'failed') LIMIT 1`,
              )
              .get(ruleId, repo, prNumber, targetKind)
          : db
              .prepare(
                `SELECT 1 AS hit FROM runs
                 WHERE rule_id = ? AND repo = ? AND pr_number = ? AND head_sha = ?
                   AND target_kind = ?
                   AND status NOT IN ('skipped', 'failed') LIMIT 1`,
              )
              .get(ruleId, repo, prNumber, headSha, targetKind);
      return row !== undefined;
    },

    listComments(runId: string): RunComment[] {
      const rows = db
        .prepare(`SELECT * FROM run_comments WHERE run_id = ?`)
        .all(runId) as Row[];
      return rows.map((row) => ({
        runId: text(row, "run_id"),
        githubId: typeof row.github_id === "string" ? row.github_id : null,
        kind: text(row, "kind", "summary") as RunComment["kind"],
        path: typeof row.path === "string" ? row.path : null,
        line: typeof row.line === "number" ? row.line : null,
        url: typeof row.url === "string" ? row.url : null,
        bodyExcerpt: text(row, "body_excerpt"),
        attribution: text(
          row,
          "attribution",
          "marker",
        ) as RunComment["attribution"],
      }));
    },

    replaceComments(runId: string, comments: RunComment[]): void {
      db.prepare(`DELETE FROM run_comments WHERE run_id = ?`).run(runId);
      const insert = db.prepare(
        `INSERT INTO run_comments (run_id, github_id, kind, path, line, url,
           body_excerpt, attribution) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const comment of comments) {
        insert.run(
          runId,
          comment.githubId,
          comment.kind,
          comment.path,
          comment.line,
          comment.url,
          comment.bodyExcerpt,
          comment.attribution,
        );
      }
    },

    isBootstrapped(repo: string): boolean {
      return (
        db
          .prepare(`SELECT 1 AS hit FROM watched_repos WHERE repo = ?`)
          .get(repo) !== undefined
      );
    },

    markBootstrapped(repo: string, now: number): void {
      db.prepare(
        `INSERT INTO watched_repos (repo, bootstrapped_at) VALUES (?, ?)
         ON CONFLICT(repo) DO NOTHING`,
      ).run(repo, now);
    },

    getSeen(
      repo: string,
      prNumber: number,
    ): { headSha: string; wasDraft: boolean } | null {
      const row = db
        .prepare(`SELECT * FROM seen_prs WHERE repo = ? AND pr_number = ?`)
        .get(repo, prNumber) as Row | undefined;
      if (row === undefined) return null;
      return {
        headSha: text(row, "head_sha"),
        wasDraft: num(row, "was_draft") === 1,
      };
    },

    markSeen(
      repo: string,
      prNumber: number,
      headSha: string,
      wasDraft: boolean,
      now: number,
    ): void {
      db.prepare(
        `INSERT INTO seen_prs (repo, pr_number, head_sha, was_draft, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo, pr_number) DO UPDATE SET
           head_sha = excluded.head_sha, was_draft = excluded.was_draft,
           updated_at = excluded.updated_at`,
      ).run(repo, prNumber, headSha, wasDraft ? 1 : 0, now);
    },

    isIssueBootstrapped(repo: string): boolean {
      return (
        db
          .prepare(`SELECT 1 AS hit FROM watched_issue_repos WHERE repo = ?`)
          .get(repo) !== undefined
      );
    },

    markIssueBootstrapped(repo: string, now: number): void {
      db.prepare(
        `INSERT INTO watched_issue_repos (repo, bootstrapped_at) VALUES (?, ?)
         ON CONFLICT(repo) DO NOTHING`,
      ).run(repo, now);
    },

    hasSeenIssue(repo: string, issueNumber: number): boolean {
      return (
        db
          .prepare(
            `SELECT 1 AS hit FROM seen_issues WHERE repo = ? AND issue_number = ?`,
          )
          .get(repo, issueNumber) !== undefined
      );
    },

    markIssueSeen(repo: string, issueNumber: number, now: number): void {
      db.prepare(
        `INSERT INTO seen_issues (repo, issue_number, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(repo, issue_number) DO UPDATE SET
           updated_at = excluded.updated_at`,
      ).run(repo, issueNumber, now);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
