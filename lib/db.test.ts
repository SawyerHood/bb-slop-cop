import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, MIGRATIONS } from "./db";
import type { Run } from "./types";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function makeStore() {
  const database = new Database(":memory:");
  databases.push(database);
  for (const migration of MIGRATIONS) database.exec(migration);
  return createStore(database);
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    ruleId: "rule_1",
    ruleName: "triage",
    repo: "acme/widgets",
    targetKind: "issue",
    prNumber: 42,
    prTitle: "Widget fails",
    prAuthor: "dana",
    headSha: "",
    status: "reviewing",
    mode: "shadow",
    detail: null,
    threadId: "thread_1",
    commentCount: 0,
    startedAt: 1,
    finishedAt: null,
    ...overrides,
  };
}

describe("issue persistence", () => {
  it("round-trips the target kind and keeps PR dedupe separate", () => {
    const store = makeStore();
    store.insertRun(makeRun());

    expect(store.getRun("run_1")?.targetKind).toBe("issue");
    expect(store.hasRunFor("rule_1", "acme/widgets", "issue", 42, null)).toBe(
      true,
    );
    expect(
      store.hasRunFor("rule_1", "acme/widgets", "pull_request", 42, null),
    ).toBe(false);
  });

  it("tracks the issue backlog independently from pull requests", () => {
    const store = makeStore();
    expect(store.isIssueBootstrapped("acme/widgets")).toBe(false);
    expect(store.hasSeenIssue("acme/widgets", 42)).toBe(false);

    store.markIssueBootstrapped("acme/widgets", 100);
    store.markIssueSeen("acme/widgets", 42, 100);

    expect(store.isIssueBootstrapped("acme/widgets")).toBe(true);
    expect(store.hasSeenIssue("acme/widgets", 42)).toBe(true);
    expect(store.isBootstrapped("acme/widgets")).toBe(false);
  });
});
