import { describe, expect, it } from "vitest";
import {
  attributeBody,
  buildMarker,
  decorateBody,
  hasVisibleHeader,
  parseMarker,
} from "./marker";
import {
  computeTriggers,
  evaluateRule,
  isDangerousCombination,
  isSevereCombination,
  isTrustedAuthor,
  matchGlob,
} from "./matcher";
import { buildPrompt } from "./dispatch";
import { verifyLive, verifyShadow } from "./verify";
import {
  CHECK_NAME,
  completeCheckRun,
  conclusionFor,
  outputFor,
  startCheckRun,
} from "./checks";
import type { GhClient, GhComment } from "./gh";
import type { RunStatus } from "./types";
import type { PullRequest, Rule } from "./types";
import { resolveThreadSectionId } from "./sections";
import { expandHome } from "./paths";

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule_1",
    name: "security-sweep",
    repo: "acme/checkout-api",
    enabled: true,
    mode: "shadow",
    triggers: ["ready_for_review"],
    conditions: [],
    authorTrust: "write_access",
    prompt: "Review it.",
    request: null,
    dedupe: "once_per_pr",
    reviewStrategy: "update",
    visibility: "visible",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 482,
    title: "Rotate webhook signing secrets",
    isDraft: false,
    headRefOid: "a1b2c3d",
    baseRefName: "main",
    author: { login: "dana" },
    authorAssociation: "MEMBER",
    labels: [],
    files: [{ path: "src/auth/session.go" }],
    isCrossRepository: false,
    updatedAt: "2026-07-30T10:00:00Z",
    ...overrides,
  };
}

describe("thread sections", () => {
  const sections = [
    { id: "sec_reviews", name: "Automated reviews" },
    { id: "sec_work", name: "Work" },
  ];

  it("resolves a section by name or ID", () => {
    expect(resolveThreadSectionId("Automated reviews", sections)).toBe(
      "sec_reviews",
    );
    expect(resolveThreadSectionId("sec_work", sections)).toBe("sec_work");
  });

  it("leaves threads unsectioned when the setting is empty", () => {
    expect(resolveThreadSectionId("  ", sections)).toBeUndefined();
  });

  it("fails clearly when the configured section does not exist", () => {
    expect(() => resolveThreadSectionId("Missing", sections)).toThrow(
      "no thread section named 'Missing'. Available: Automated reviews, Work",
    );
  });
});

describe("home-relative paths", () => {
  const home = "/home/sawyer";

  it("expands a leading ~/ so one setting fits two hosts", () => {
    expect(expandHome("~/.slopcop/slopcop-gh", home)).toBe(
      "/home/sawyer/.slopcop/slopcop-gh",
    );
    expect(expandHome("~/.slopcop/slopcop-gh", "/Users/sawyerhood")).toBe(
      "/Users/sawyerhood/.slopcop/slopcop-gh",
    );
  });

  it("leaves absolute and bare commands alone", () => {
    expect(expandHome("/usr/local/bin/slopcop-gh", home)).toBe(
      "/usr/local/bin/slopcop-gh",
    );
    expect(expandHome("gh", home)).toBe("gh");
    expect(expandHome("", home)).toBe("");
  });

  it("refuses to guess at another user's home", () => {
    expect(expandHome("~other/.slopcop/gh", home)).toBe("~other/.slopcop/gh");
    expect(expandHome("/opt/~/gh", home)).toBe("/opt/~/gh");
    expect(expandHome("~", home)).toBe(home);
  });
});

describe("bot posting command", () => {
  const context = (ghCommand?: string) => ({
    rule: makeRule({ mode: "live" as const }),
    pullRequest: makePr(),
    runId: "run_1",
    ghCommand,
  });

  it("defaults to plain gh and adds no bot note", () => {
    const prompt = buildPrompt(context());
    expect(prompt).toContain("Post your review to the PR with `gh`.");
    expect(prompt).not.toContain("SlopCop identity");
  });

  it("routes writes through the configured wrapper", () => {
    const prompt = buildPrompt(context("/home/me/.slopcop/slopcop-gh"));
    expect(prompt).toContain(
      "`/home/me/.slopcop/slopcop-gh pr review --comment`",
    );
    expect(prompt).toContain("Plain `gh` is fine for reads.");
    expect(prompt).not.toContain("Post your review to the PR with `gh`.");
  });

  it("treats a blank wrapper setting as unset", () => {
    expect(buildPrompt(context("   "))).toContain(
      "Post your review to the PR with `gh`.",
    );
  });

  it("never tells a shadow rule to post, wrapper or not", () => {
    const prompt = buildPrompt({
      ...context("/home/me/.slopcop/slopcop-gh"),
      rule: makeRule({ mode: "shadow" }),
    });
    expect(prompt).toContain("DO NOT POST ANYTHING");
    expect(prompt).not.toContain("slopcop-gh");
  });
});

describe("markers", () => {
  it("round-trips", () => {
    const marker = {
      rule: "security-sweep",
      run: "run_1",
      sha: "a1b2c3d",
      kind: "inline" as const,
    };
    expect(parseMarker(buildMarker(marker))).toEqual(marker);
  });

  it("neutralizes rule names that would break out of the comment", () => {
    const built = buildMarker({
      rule: "evil --> <script>",
      run: "run_1",
      sha: "x",
      kind: "summary",
    });
    expect(built.match(/-->/g)).toHaveLength(1);
    expect(parseMarker(built)?.kind).toBe("summary");
  });

  it("attributes only markers belonging to the same run", () => {
    const body = decorateBody("finding", "inline", {
      rule: "r",
      run: "run_1",
      sha: "s",
      kind: "inline",
    });
    expect(attributeBody(body, "run_1")).toBe("marker");
    expect(attributeBody(body, "run_2")).toBeNull();
  });

  it("falls back to the visible header when the marker is missing", () => {
    expect(attributeBody("🚨 **SLOP COP** 🚨 · `r`\n\nfindings", "run_1")).toBe(
      "header",
    );
    expect(attributeBody("just a normal human comment", "run_1")).toBeNull();
  });

  it("recognizes both header shapes", () => {
    expect(hasVisibleHeader("🚨 **SLOP COP** 🚨 · `r`")).toBe(true);
    expect(hasVisibleHeader("🚨 `slopcop/security-sweep` — bad compare")).toBe(
      true,
    );
    expect(hasVisibleHeader("looks fine to me")).toBe(false);
  });

  it("gives the summary a banner and inline comments a one-liner", () => {
    const marker = {
      rule: "r",
      run: "run_1",
      sha: "s",
      kind: "summary" as const,
    };
    expect(decorateBody("body", "summary", marker)).toContain("**SLOP COP**");
    expect(
      decorateBody("body", "inline", { ...marker, kind: "inline" }),
    ).toContain("`slopcop/r` — body");
  });
});

describe("globs", () => {
  it("keeps * inside a path segment and lets ** cross", () => {
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/nested/a.ts")).toBe(false);
    expect(matchGlob("src/**", "src/nested/deep/a.ts")).toBe(true);
    expect(matchGlob("src/auth/**", "src/auth")).toBe(true);
  });

  it("does not let regex metacharacters in a pattern leak through", () => {
    expect(matchGlob("src/a.ts", "src/aXts")).toBe(false);
  });
});

describe("author trust", () => {
  it("excludes CONTRIBUTOR from write access — it only means 'merged before'", () => {
    expect(isTrustedAuthor("COLLABORATOR", "write_access")).toBe(true);
    expect(isTrustedAuthor("CONTRIBUTOR", "write_access")).toBe(false);
    expect(isTrustedAuthor("CONTRIBUTOR", "past_contributors")).toBe(true);
    expect(isTrustedAuthor("NONE", "anyone")).toBe(true);
  });

  it("blocks an untrusted author and says why", () => {
    const result = evaluateRule(
      makeRule(),
      makePr({ authorAssociation: "FIRST_TIME_CONTRIBUTOR", author: { login: "randal" } }),
      "ready_for_review",
    );
    expect(result).toMatchObject({ matched: false, blockedByTrust: true });
    if (!result.matched) {
      expect(result.reason).toContain("@randal");
      expect(result.reason).toContain("FIRST_TIME_CONTRIBUTOR");
    }
  });

  it("reports the trust gate ahead of an incidental condition miss", () => {
    const result = evaluateRule(
      makeRule({
        authorTrust: "write_access",
        conditions: [{ kind: "paths", globs: ["nothing/**"] }],
      }),
      makePr({ authorAssociation: "NONE" }),
      "ready_for_review",
    );
    expect(result).toMatchObject({ blockedByTrust: true });
  });

  it("treats 'anyone' as dangerous regardless of mode — none of BB's permission modes is read-only", () => {
    const request = {
      projectId: "p",
      providerId: "claude",
      model: "m",
      permissionMode: "auto",
      environment: null,
      input: null,
    };
    const dangerous = makeRule({ authorTrust: "anyone", request });
    expect(isDangerousCombination(dangerous)).toBe(true);
    expect(isSevereCombination(dangerous)).toBe(false);
    expect(
      isSevereCombination({
        ...dangerous,
        request: { ...request, permissionMode: "full" },
      }),
    ).toBe(true);
    expect(
      isDangerousCombination({ ...dangerous, authorTrust: "write_access" }),
    ).toBe(false);
  });
});

describe("trigger detection", () => {
  const base = { isDraft: false, headSha: "sha1", repoBootstrapped: true };

  it("fires on a PR opened directly as ready-for-review", () => {
    // The regression that silently ignored most PRs: unseen + already watching
    // is a NEW pull request, not backlog.
    expect(computeTriggers({ ...base, seen: null })).toEqual([
      "ready_for_review",
    ]);
  });

  it("does not fire on the backlog during the first pass over a repo", () => {
    expect(
      computeTriggers({ ...base, seen: null, repoBootstrapped: false }),
    ).toEqual([]);
  });

  it("fires when a draft is marked ready", () => {
    expect(
      computeTriggers({
        ...base,
        seen: { headSha: "sha1", wasDraft: true },
      }),
    ).toEqual(["ready_for_review"]);
  });

  it("fires on new commits, and stays quiet when nothing moved", () => {
    expect(
      computeTriggers({
        ...base,
        seen: { headSha: "old", wasDraft: false },
      }),
    ).toEqual(["new_commits"]);
    expect(
      computeTriggers({
        ...base,
        seen: { headSha: "sha1", wasDraft: false },
      }),
    ).toEqual([]);
  });

  it("never fires for a draft", () => {
    expect(
      computeTriggers({ ...base, isDraft: true, seen: null }),
    ).toEqual([]);
    expect(
      computeTriggers({
        ...base,
        isDraft: true,
        seen: { headSha: "old", wasDraft: false },
      }),
    ).toEqual([]);
  });
});

describe("conditions", () => {
  it("matches paths, labels and base branch", () => {
    const rule = makeRule({
      conditions: [
        { kind: "paths", globs: ["src/auth/**"] },
        { kind: "base_branch", globs: ["main"] },
        { kind: "missing_label", labels: ["no-review"] },
      ],
    });
    expect(evaluateRule(rule, makePr(), "ready_for_review").matched).toBe(true);

    const labelled = evaluateRule(
      rule,
      makePr({ labels: [{ name: "no-review" }] }),
      "ready_for_review",
    );
    expect(labelled.matched).toBe(false);
    if (!labelled.matched) expect(labelled.reason).toContain("no-review");
  });

  it("never matches on a malformed title regex", () => {
    const rule = makeRule({
      conditions: [{ kind: "title_matches", regex: "([unclosed" }],
    });
    expect(evaluateRule(rule, makePr(), "ready_for_review").matched).toBe(false);
  });

  it("skips drafts and disabled rules", () => {
    expect(
      evaluateRule(makeRule(), makePr({ isDraft: true }), "ready_for_review")
        .matched,
    ).toBe(false);
    expect(
      evaluateRule(makeRule({ enabled: false }), makePr(), "ready_for_review")
        .matched,
    ).toBe(false);
  });

  it("honours the trigger the rule listens for, but manual always runs", () => {
    const rule = makeRule({ triggers: ["ready_for_review"] });
    expect(evaluateRule(rule, makePr(), "new_commits").matched).toBe(false);
    expect(evaluateRule(rule, makePr(), "manual").matched).toBe(true);
  });
});

function ghComment(overrides: Partial<GhComment> = {}): GhComment {
  return {
    id: "1",
    body: "hello",
    url: "https://github.com/x/1",
    author: "octocat",
    path: null,
    line: null,
    createdAt: 2_000,
    ...overrides,
  };
}

function fakeGh(parts: {
  issues?: GhComment[];
  review?: GhComment[];
  reviews?: GhComment[];
}): GhClient {
  return {
    listOpenPullRequests: async () => [],
    getPullRequest: async () => makePr(),
    listFiles: async () => [],
    listIssueComments: async () => parts.issues ?? [],
    listReviewComments: async () => parts.review ?? [],
    listReviews: async () => parts.reviews ?? [],
    authenticatedLogin: async () => "octocat",
    request: async () => null,
  };
}

const marked = (kind: "summary" | "inline", run = "run_1") =>
  decorateBody("a finding", kind, {
    rule: "security-sweep",
    run,
    sha: "a1b2c3d",
    kind,
  });

describe("live verification", () => {
  const base = {
    repo: "acme/checkout-api",
    prNumber: 482,
    runId: "run_1",
    startedAt: 1_000,
    authenticatedLogin: "octocat",
  };

  it("collects every marked comment across all three surfaces", async () => {
    const result = await verifyLive({
      ...base,
      gh: fakeGh({
        issues: [ghComment({ id: "a", body: marked("summary") })],
        review: [
          ghComment({ id: "b", body: marked("inline"), path: "x.go", line: 88 }),
          ghComment({ id: "c", body: marked("inline"), path: "y.go", line: 3 }),
        ],
      }),
    });
    expect(result.status).toBe("commented");
    expect(result.comments).toHaveLength(3);
    expect(result.comments.find((c) => c.githubId === "b")?.line).toBe(88);
  });

  it("reports no_comment rather than silently succeeding", async () => {
    const result = await verifyLive({ ...base, gh: fakeGh({}) });
    expect(result.status).toBe("no_comment");
    expect(result.detail).toContain("without posting");
  });

  it("ignores another run's comments", async () => {
    const result = await verifyLive({
      ...base,
      gh: fakeGh({
        issues: [ghComment({ body: marked("summary", "run_OTHER") })],
      }),
    });
    // Still ours by header, so it is flagged rather than counted as a success.
    expect(result.status).toBe("commented_unmarked");
  });

  it("ignores comments predating the run and comments by other people", async () => {
    const result = await verifyLive({
      ...base,
      gh: fakeGh({
        issues: [
          ghComment({ id: "old", body: "🚨 SLOP COP 🚨 old", createdAt: 5 }),
          ghComment({ id: "human", body: "nice work", author: "someone-else" }),
        ],
      }),
    });
    expect(result.status).toBe("no_comment");
  });

  it("ignores GitHub's empty review envelopes rather than calling them unattributed", async () => {
    const result = await verifyLive({
      ...base,
      gh: fakeGh({
        review: [
          ghComment({ id: "a", body: marked("inline"), path: "x.go", line: 8 }),
        ],
        reviews: [
          ghComment({ id: "env1", body: "" }),
          ghComment({ id: "env2", body: "   " }),
        ],
      }),
    });
    expect(result.status).toBe("commented");
    expect(result.comments).toHaveLength(1);
  });

  it("flags a partially marked review", async () => {
    const result = await verifyLive({
      ...base,
      gh: fakeGh({
        issues: [ghComment({ id: "a", body: marked("summary") })],
        review: [ghComment({ id: "b", body: "🚨 `slopcop/x` — forgot marker" })],
      }),
    });
    expect(result.status).toBe("commented_partial");
    expect(result.comments).toHaveLength(2);
  });

  it("flags an unattributable comment from our own account", async () => {
    const result = await verifyLive({
      ...base,
      gh: fakeGh({ issues: [ghComment({ body: "plain review, no header" })] }),
    });
    expect(result.status).toBe("commented_unattributed");
  });
});

describe("shadow verification", () => {
  it("accepts a well-formed shadow review", () => {
    const result = verifyShadow({
      runId: "run_1",
      finalMessage: marked("summary"),
    });
    expect(result.status).toBe("shadowed");
    expect(result.comments[0]?.githubId).toBeNull();
  });

  it("catches a review that would post unattributably if promoted", () => {
    const result = verifyShadow({
      runId: "run_1",
      finalMessage: "🚨 **SLOP COP** 🚨 · `r`\n\nfindings but no marker",
    });
    expect(result.status).toBe("commented_unmarked");
  });

  it("catches a review that ignored the format contract entirely", () => {
    const result = verifyShadow({
      runId: "run_1",
      finalMessage: "looks good to me",
    });
    expect(result.status).toBe("commented_unattributed");
  });

  it("catches an empty turn", () => {
    expect(verifyShadow({ runId: "run_1", finalMessage: null }).status).toBe(
      "no_comment",
    );
  });
});

describe("github checks", () => {
  it("treats a posted review as success so it does not fail merges", () => {
    const posted: RunStatus[] = [
      "commented",
      "commented_partial",
      "commented_unmarked",
    ];
    for (const status of posted) {
      expect(conclusionFor(status)).toBe("success");
    }
  });

  it("does not open or complete a check for shadow or in-flight runs", () => {
    expect(conclusionFor("shadowed")).toBeNull();
    expect(conclusionFor("reviewing")).toBeNull();
    expect(conclusionFor("dispatched")).toBeNull();
  });

  it("uses the same check name GitHub groups in the merge box", () => {
    expect(CHECK_NAME).toBe("SlopCop");
  });

  it("creates an in_progress check and later completes the same run", async () => {
    const calls: { method: string; endpoint: string; body: unknown }[] = [];
    const request: GhClient["request"] = async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (method === "POST") return { id: 99 };
      if (method === "GET") {
        return {
          check_runs: [
            { id: 99, external_id: "run_1", status: "in_progress" },
          ],
        };
      }
      return { id: 99 };
    };

    await startCheckRun(request, {
      repo: "acme/checkout-api",
      sha: "a1b2c3d",
      runId: "run_1",
      ruleName: "security-sweep",
      prNumber: 482,
    });
    await completeCheckRun(request, {
      repo: "acme/checkout-api",
      sha: "a1b2c3d",
      runId: "run_1",
      ruleName: "security-sweep",
      prNumber: 482,
      status: "commented",
      commentCount: 2,
      detail: null,
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.endpoint).toBe("repos/acme/checkout-api/check-runs");
    expect(calls[0]?.body).toMatchObject({
      name: "SlopCop",
      head_sha: "a1b2c3d",
      status: "in_progress",
      external_id: "run_1",
    });
    expect(calls[2]?.method).toBe("PATCH");
    expect(calls[2]?.endpoint).toBe("repos/acme/checkout-api/check-runs/99");
    expect(calls[2]?.body).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });

  it("posts a completed check when no in-progress run exists to patch", async () => {
    const calls: { method: string; endpoint: string; body: unknown }[] = [];
    const request: GhClient["request"] = async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (method === "GET") return { check_runs: [] };
      return { id: 7 };
    };
    await completeCheckRun(request, {
      repo: "acme/checkout-api",
      sha: "deadbeef",
      runId: "run_9",
      ruleName: "security-sweep",
      prNumber: 1,
      status: "failed",
      commentCount: 0,
      detail: "thread crashed",
    });
    expect(calls.at(-1)?.method).toBe("POST");
    expect(calls.at(-1)?.body).toMatchObject({
      head_sha: "deadbeef",
      conclusion: "failure",
      external_id: "run_9",
    });
    expect(outputFor({
      repo: "acme/checkout-api",
      sha: "deadbeef",
      runId: "run_9",
      ruleName: "security-sweep",
      prNumber: 1,
      status: "failed",
      commentCount: 0,
      detail: "thread crashed",
    }).title).toBe("Review failed");
  });
});
