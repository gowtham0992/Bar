# Evidence Capture Contract

This contract defines how Bar may collect, preserve, and promote GitHub Actions evidence without placing credentials or unsanitized CI data in the repository.

## Status

- Scope: the two failed jobs in Link PR #60, followed by future Bar investigations.
- Audience: the collector and sanitizer implementer, the repository reviewer, and anyone approving a public replay fixture.
- This document is normative. `MUST`, `MUST NOT`, `SHOULD`, and `MAY` describe requirements.
- Application scaffolding, live webhook handling, and the PRD are out of scope.

## Security objective

An attacker can influence repository contents, commit messages, workflow output, filenames, and environment values. Their prize is disclosure of credentials or private CI evidence through the Bar repository, public demo, model prompt, logs, or build artifacts.

The capture pipeline therefore uses three zones:

1. **Raw vault:** authenticated GitHub responses and local reproduction output. It stays outside the Bar repository.
2. **Sanitized candidate:** sanitizer output staged outside the repository for automated and human review.
3. **Public fixture:** the reviewed, allowlisted candidate promoted into `fixtures/public/`.

No command may write authenticated GitHub data directly into the repository.

## Hard boundaries

### Raw evidence stays outside Git

- The collector MUST require an explicit output directory.
- It MUST resolve the output directory to a canonical absolute path and refuse to run when that path is the Bar worktree, is inside the worktree, or reaches the worktree through a symlink.
- It MUST refuse a destination that already contains unrelated files unless an explicit resume operation proves that the existing capture has the same repository, pull request, run, attempt, and head SHA.
- The raw directory MUST be owner-readable and owner-writable only.
- Raw files MUST NOT be opened in a browser, copied into a prompt, emitted to standard output, or attached to an issue.
- The raw directory MUST contain a marker such as `BAR_RAW_EVIDENCE_DO_NOT_COMMIT` so an accidental copy is recognizable.

### Sanitized candidates also stage outside Git

- The sanitizer MUST write to a separate empty directory outside the worktree.
- The sanitizer MUST NOT modify the raw vault.
- Promotion into `fixtures/public/` is a separate, explicit operation that runs only after every verification gate in this contract and `SANITIZER_SPEC.md` passes.

### Public fixtures are immutable inputs

- A fixture ID MUST identify one sanitized capture of one repository, run attempt, and failure scenario.
- Published fixture content MUST NOT change in place. A correction creates a new fixture revision.
- The public demo MUST accept only fixture IDs included in its build-time allowlist. It must never accept a repository name, run ID, job ID, SHA, file path, or URL supplied by the visitor as a fetch target.

## Authentication rules

The one-time PR #60 capture SHOULD use GitHub CLI browser authentication or a short-lived fine-grained token restricted to `gowtham0992/link`. Production collection will use a GitHub App installation token.

- Credentials MUST be read from the operating-system credential store, a secret manager, or a process environment populated outside the command line.
- Credentials MUST NOT be accepted as command-line arguments, placed in a URL, written to configuration in this repository, or printed in errors.
- Shell tracing MUST be disabled for authenticated collection.
- HTTP request headers MUST NOT be stored in the evidence bundle.
- The collector MUST NOT log response headers from log-download endpoints because the `Location` header contains a short-lived signed URL.
- GitHub API requests MUST send `Accept: application/vnd.github+json` and pin `X-GitHub-Api-Version: 2026-03-10`. The pinned version is recorded in `capture.json`.
- A credential exposed in a file, terminal transcript, prompt, or commit is considered compromised and must be rotated.

Minimum GitHub repository permissions are:

| Permission | Level | Purpose |
| --- | --- | --- |
| Actions | Read | Run attempts, jobs, steps, logs, and relevant artifacts |
| Contents | Read | Workflow and source files at immutable SHAs |
| Pull requests | Read | PR metadata, commits, files, and patches |
| Checks | Read | Check-run records and annotations |
| Metadata | Read | Repository identity; implicit for GitHub Apps |

The collector MUST NOT require Actions write, Contents write, Workflows write, Administration, Secrets, or Issues permissions.

## Capture identity must be frozen first

Before downloading logs or source material, the collector MUST write `capture.json` containing:

- repository owner and name;
- repository visibility at capture time;
- pull request number;
- workflow run ID and attempt number;
- workflow ID and workflow path;
- event name;
- base and head refs;
- immutable base and head SHAs;
- check suite ID;
- requested failed job IDs;
- collector version;
- capture start time in UTC.
- pinned GitHub API version.

Every later response MUST be checked against this identity. A head SHA, attempt number, repository, or job/run relationship mismatch fails the capture. Moving branch names are metadata only; immutable SHAs are authoritative.

## Required GitHub evidence

The collector MUST capture the following records for PR #60.

| Record | Endpoint or source | Required handling |
| --- | --- | --- |
| Run attempt | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}` | Preserve event, workflow identity, attempt, actors, SHAs, timestamps, status, and conclusion. |
| Jobs and steps | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs` | Follow pagination. Preserve all jobs, not only failures, because passing jobs constrain the diagnosis. |
| Failed job logs | `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` | Follow the redirect directly to a file. Never persist the signed redirect URL. |
| Check runs | Check runs for the frozen head SHA | Preserve names, IDs, status, conclusion, start/end times, details URL, and annotation count. |
| Check annotations | Annotations for both failed check-run IDs | Follow pagination. Preserve GitHub-visible warnings and failures separately from raw logs. |
| Pull request | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | Preserve title, body, state, base/head identities, public URL, and change counts. |
| PR commits | `GET /repos/{owner}/{repo}/pulls/{pull_number}/commits` | Follow pagination. PR endpoints return at most 250 commits; record incompleteness and use commit listing or compare data if the cap is reached. |
| PR files | `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` | Follow pagination. Record when `patch` is absent or truncated. The endpoint caps results at 3,000 files. |
| Base/head comparison | `GET /repos/{owner}/{repo}/compare/{base}...{head}` | Preserve comparison status and commit/file inventory. Record API truncation rather than treating absence as no change. |
| Workflow file | Contents API for `.github/workflows/ci.yml` at both SHAs | Decode and preserve exact bytes plus hashes. |
| Relevant source files | Contents API at both SHAs | Select from failed-step commands, traceback paths, packaging metadata, and related diff hunks. Record why each file was selected. |
| Relevant artifacts | Run artifacts endpoint | Capture only artifacts tied to a failed job or necessary to understand it. Record `none` when none qualify. |

GitHub log-download endpoints return short-lived redirects. The raw bundle records the stable API endpoint and downloaded body hash, never the redirect target.

Current references:

- <https://docs.github.com/en/rest/actions/workflow-runs>
- <https://docs.github.com/en/rest/actions/workflow-jobs>
- <https://docs.github.com/en/rest/checks/runs>
- <https://docs.github.com/en/rest/pulls/pulls>
- <https://docs.github.com/en/rest/commits/commits>
- <https://docs.github.com/en/rest/repos/contents>

## PR #60 capture manifest

The first capture is pinned to:

| Field | Value |
| --- | --- |
| Repository | `gowtham0992/link` |
| Pull request | `60` |
| Workflow run | `31668261705` |
| Attempt | `1` |
| Base SHA | `643e208adbbe2dfd1c91bf9e8305e6dec2b037a6` |
| Head SHA | `d1b707d6da5f2331719e3e7d7fc70a0e6faff32c` |
| Package job | `94347441040` |
| Windows job | `94347441096` |

The initial relevant-file seed is:

- `.github/workflows/ci.yml` at base and head;
- `mcp_package/pyproject.toml` at base and head;
- `mcp_package/link_core/demo.py` at base and head;
- `tests/test_installers.py` at base and head.

The Windows log may add files through a traceback or failed-test reference. The collector may fetch those files only at the already frozen base and head SHAs.

## Local reproduction is a separate evidence source

The known package reproduction MUST be captured separately from GitHub data. Its record contains:

- exact working directory and argument array;
- operating system and architecture;
- Python, `build`, and `hatchling` versions;
- start/end time and exit code;
- complete standard output and standard error;
- SHA-256 of the combined raw transcript;
- a source label of `local_reproduction`, never `github_log`.

The reproduction command MUST run from a clean snapshot of the frozen head SHA. Environment variables are not captured wholesale; only the allowlisted execution metadata above is recorded.

## Raw bundle layout

The collector SHOULD produce this layout outside the worktree:

```text
bar-link-pr60-run31668261705-attempt1/
  BAR_RAW_EVIDENCE_DO_NOT_COMMIT
  capture.json
  manifest.json
  github/
    run-attempt.json
    jobs.json
    logs/
      package.log
      windows-smoke.log
    checks/
      check-runs.json
      package-annotations.json
      windows-smoke-annotations.json
    pull-request.json
    pull-commits.json
    pull-files.json
    compare.json
    contents/
      base/
      head/
  local/
    package-reproduction.txt
    package-reproduction.json
```

`manifest.json` contains one entry per file:

- logical evidence type;
- stable GitHub API endpoint with secret-bearing query data removed;
- HTTP status and media type;
- byte length;
- SHA-256 of the exact bytes;
- capture time;
- pagination page, where relevant;
- completeness status: `complete`, `truncated`, `not_available`, or `not_applicable`;
- an error code when capture was incomplete.

It MUST NOT contain authorization headers, cookies, signed redirect targets, or raw sensitive values copied from response bodies.

## Collection failure behavior

The collector fails closed when:

- authentication is missing or broader permissions are unexpectedly required;
- an identity field conflicts with `capture.json`;
- a required page or job log cannot be downloaded;
- pagination is incomplete;
- a response media type is unexpected;
- a required file hash cannot be computed;
- the output path crosses into the repository;
- a destination file would be overwritten with different bytes.

A partial capture may remain in the raw vault for diagnosis, but it cannot be sanitized or promoted. Its manifest must say `capture_status: incomplete`.

The Windows job is allowed to produce an evidentially complete capture that is diagnostically insufficient. That is not a capture failure. Missing or generic evidence becomes an explicit finding in the fixture.

## Integrity and provenance

- SHA-256 protects evidence integrity; it is not a secrecy mechanism.
- Exact raw hashes remain in the private manifest.
- A public fixture records sanitized artifact hashes and opaque provenance IDs. It does not need to publish hashes of secret-bearing raw files.
- Evidence order, job name, step name, source path, and original line range MUST survive sanitization when needed for citations.
- Every public evidence item MUST trace to one or more private manifest entries without copying raw content into the provenance record.

## Retention and deletion

- The raw vault SHOULD remain encrypted while the fixture is being reviewed.
- Raw evidence MUST NOT be synchronized by Git, cloud-drive defaults, or backup tooling unless that storage is explicitly approved for sensitive CI evidence.
- After fixture approval, the owner chooses either encrypted retention for reproducibility or verified deletion. The choice and date are recorded outside the public fixture.
- Sanitized candidates that fail review MUST be deleted and regenerated; they must not be patched by hand in the repository.

## Promotion gate

A fixture may enter `fixtures/public/` only when:

1. capture identity and completeness checks pass;
2. every raw file has a manifest hash;
3. the sanitizer completes without unresolved findings;
4. automated sensitive-data scans pass;
5. the exact-value survivor check passes;
6. a human reviews the sanitized candidate without opening it through the public app;
7. all evidence citations resolve;
8. evaluator-only expected results are absent from the fixture input tree;
9. a clean-room replay loads the fixture without access to the raw vault;
10. the public deployment manifest contains no private binding or credential.

## Non-goals

This contract does not define:

- GitHub webhook ingestion;
- the live Bar database schema;
- Cloudflare deployment configuration;
- public-demo rate-limit values;
- model prompts or diagnosis scoring;
- automatic fixes, reruns, or repository writes.
