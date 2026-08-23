---
name: slopcop
description: Configure automated PR review rules with the `bb slopcop` CLI. Use when asked to set up, change, inspect, or debug automatic pull-request reviews — creating a review rule for a repo, changing what a rule looks for, restricting which authors get reviewed, checking why a PR was or was not reviewed, or reading what a shadow-mode rule would have posted.
---

# SlopCop — automated PR review rules

A **rule** watches one GitHub repo and dispatches a BB agent to review PRs that
match it. Rules are configured entirely from the CLI, so you can set them up on
the user's behalf.

## Safety defaults — do not loosen without being asked

Two defaults exist to stop the agent running untrusted code, and you should
leave them alone unless the user explicitly asks:

- **`--trust write_access`** (default) — only reviews PRs from `OWNER`,
  `MEMBER`, `COLLABORATOR`. Note that GitHub's `CONTRIBUTOR` means only "has
  had a commit merged before", **not** write access; `--trust past_contributors`
  includes those drive-by authors, and `--trust anyone` reviews strangers'
  forks. Reviewing an untrusted PR means the agent runs `gh pr checkout` on
  unvetted code and reads an attacker-controlled diff into its own prompt.
- **shadow mode** (default for new rules) — the rule runs the full review and
  stores the body, but posts nothing. Promote with `--live` only when the user
  has seen a shadow result and asked for it.

## Creating a rule

A rule needs a repo AND an agent configuration (`--project` at minimum), or it
cannot dispatch:

```sh
bb slopcop rules add \
  --name security-sweep \
  --repo owner/repo \
  --project <bb-project-name> \
  --model claude-opus-5 \
  --paths "src/auth/**,src/payments/**" \
  --base main \
  --prompt "Review the diff for auth and payment issues. Post each finding as a line comment on the diff."
```

Flags: `--name --repo --project --provider --model --reasoning --permission
--prompt --paths --base --label --skip-label --trust --dedupe --strategy
--trigger --live --shadow --disabled --hidden --visible`.

`--hidden` spawns review threads with `visibility: "hidden"`: they stay out of
sidebar organization and raise no unread or notification attention. Right for a
rule that fires often. Default is `--visible`, so a new rule is watchable while
you tune it.

Set a default BB section for all new review threads with a section name or ID:

```sh
bb plugin config slopcop set defaultThreadSection "Automated reviews"
```

Clear `defaultThreadSection` to create review threads without a section. A run
fails with an explicit error if the configured section no longer exists.

Permission modes are BB's own: `full`, `auto` (default), `accept-edits`. There
is no read-only mode, which is why the trust gate is the real protection.

## Inspecting and debugging

```sh
bb slopcop rules                       # list rules
bb slopcop status                      # gh auth, watched repos, poll interval
bb slopcop check <rule> <pr-number>    # dry run: match or the exact reason it did not
bb slopcop runs [--rule <r>] [--json]  # recent runs and their status
bb slopcop show [run-id]               # the review body a run produced
bb slopcop dispatch <rule> <pr> [--force]
bb slopcop rules edit|enable|disable|rm <rule>
```

`check` is the right tool for "why didn't SlopCop review my PR?" — it reports
the single decisive reason (draft, trust gate, a specific condition).

## Run statuses

`shadowed` (shadow review produced, nothing posted) · `commented` (verified on
GitHub by marker) · `commented_partial` / `commented_unmarked` /
`commented_unattributed` (posted but attribution degraded — the prompt contract
slipped) · `no_comment` (thread finished without posting) · `skipped` (a rule
matched nothing, e.g. blocked by the trust gate) · `failed`.

Every comment SlopCop posts carries a visible `🚨 SLOP COP 🚨` header and a
hidden `<!-- slopcop:… -->` marker; verification polls GitHub for that marker
rather than trusting the agent's transcript. Later runs on the same PR are
given this rule's existing comments and told not to post the same finding
again. GitHub line comments are a title plus two sentences, not the full
review memo.
