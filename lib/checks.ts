// GitHub Checks API — the merge-box row CodeRabbit and CI occupy.
//
// Live reviews create an in_progress check named "SlopCop" as soon as the
// thread is spawned, then complete it from verified GitHub state. Shadow runs
// post nothing, so they never open a check. A missing Checks permission must
// not fail the review: the comment is still the product.
import type { RunStatus } from "./types";

export const CHECK_NAME = "SlopCop";

export type CheckConclusion = "success" | "failure" | "neutral";

export interface CheckRequest {
  (
    method: "GET" | "POST" | "PATCH",
    endpoint: string,
    body?: unknown,
  ): Promise<unknown>;
}

export interface StartCheckInput {
  repo: string;
  sha: string;
  runId: string;
  ruleName: string;
  prNumber: number;
}

export interface CompleteCheckInput extends StartCheckInput {
  status: RunStatus;
  commentCount: number;
  detail: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function prUrl(repo: string, prNumber: number): string {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

/**
 * Maps a finished run onto a check conclusion. `null` means this status is
 * not a completion — either still in flight, or a shadow/skip that never
 * opened a check.
 *
 * Posted reviews are `success` even when they found issues: the comments are
 * the findings. A red X would block merges the way required CI does, which
 * is not what a review bot is for unless the user makes the check required.
 */
export function conclusionFor(status: RunStatus): CheckConclusion | null {
  switch (status) {
    case "commented":
    case "commented_partial":
    case "commented_unmarked":
      return "success";
    case "no_comment":
    case "commented_unattributed":
      return "neutral";
    case "failed":
      return "failure";
    case "skipped":
    case "shadowed":
    case "dispatched":
    case "reviewing":
      return null;
  }
}

export function outputFor(input: CompleteCheckInput): {
  title: string;
  summary: string;
} {
  const { status, ruleName, prNumber, commentCount, detail } = input;
  const extra = detail !== null && detail.length > 0 ? `\n\n${detail}` : "";
  switch (status) {
    case "commented":
      return {
        title: "Review posted",
        summary: `SlopCop finished \`${ruleName}\` on PR #${prNumber} and posted ${commentCount} comment(s).${extra}`,
      };
    case "commented_partial":
    case "commented_unmarked":
      return {
        title: "Review posted with attribution drift",
        summary: `SlopCop posted on PR #${prNumber}, but some comments were missing the required marker.${extra}`,
      };
    case "no_comment":
      return {
        title: "Review finished without a comment",
        summary: `SlopCop ran \`${ruleName}\` on PR #${prNumber} but posted nothing.${extra}`,
      };
    case "commented_unattributed":
      return {
        title: "Review not attributable",
        summary: `A comment landed on PR #${prNumber} but could not be proven as SlopCop's.${extra}`,
      };
    case "failed":
      return {
        title: "Review failed",
        summary: `SlopCop failed while reviewing PR #${prNumber} with \`${ruleName}\`.${extra}`,
      };
    default:
      return {
        title: "SlopCop",
        summary: `Rule \`${ruleName}\` on PR #${prNumber}: ${status}.${extra}`,
      };
  }
}

function checkId(value: unknown): number | null {
  const id = asRecord(value).id;
  return typeof id === "number" ? id : null;
}

async function findCheckRunId(
  request: CheckRequest,
  input: StartCheckInput,
): Promise<number | null> {
  const payload = await request(
    "GET",
    `repos/${input.repo}/commits/${input.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}`,
  );
  const rows = asRecord(payload).check_runs;
  if (!Array.isArray(rows)) return null;
  const ours = rows.filter(
    (row) => asRecord(row).external_id === input.runId,
  );
  const inProgress = ours.find(
    (row) => asRecord(row).status === "in_progress",
  );
  return checkId(inProgress ?? ours[0] ?? null);
}

export async function startCheckRun(
  request: CheckRequest,
  input: StartCheckInput,
): Promise<number | null> {
  const created = await request(
    "POST",
    `repos/${input.repo}/check-runs`,
    {
      name: CHECK_NAME,
      head_sha: input.sha,
      status: "in_progress",
      external_id: input.runId,
      details_url: prUrl(input.repo, input.prNumber),
      started_at: new Date().toISOString(),
      output: {
        title: "Reviewing",
        summary: `SlopCop is running \`${input.ruleName}\` on PR #${input.prNumber}.`,
      },
    },
  );
  return checkId(created);
}

export async function completeCheckRun(
  request: CheckRequest,
  input: CompleteCheckInput,
): Promise<void> {
  const conclusion = conclusionFor(input.status);
  if (conclusion === null) return;

  const body = {
    name: CHECK_NAME,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    details_url: prUrl(input.repo, input.prNumber),
    output: outputFor(input),
  };

  const existing = await findCheckRunId(request, input);
  if (existing !== null) {
    await request(
      "PATCH",
      `repos/${input.repo}/check-runs/${existing}`,
      body,
    );
    return;
  }

  await request("POST", `repos/${input.repo}/check-runs`, {
    ...body,
    head_sha: input.sha,
    external_id: input.runId,
    started_at: new Date().toISOString(),
  });
}
