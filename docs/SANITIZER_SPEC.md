# Sanitizer and Public Fixture Specification

The sanitizer turns a sealed raw capture into a minimal, source-linked fixture that can safely pass through Bar's real public-demo Workflow, Agent state, and Workers AI diagnosis.

## Status

- Input contract: `EVIDENCE_CAPTURE_CONTRACT.md`.
- Output: a sanitized candidate outside the repository, later promoted to `fixtures/public/` after review.
- Audience: sanitizer implementers, security reviewers, fixture authors, and evaluator authors.
- Application scaffolding and sanitizer implementation are out of scope.

## Security and fidelity goals

The sanitizer must satisfy both goals:

1. **Confidentiality:** no credential, private environment value, personal identifier, signed URL, or unrelated CI content reaches Git, the public demo, Agent state, or Workers AI.
2. **Diagnostic fidelity:** the fixture retains enough ordered, addressable evidence for Bar to diagnose the failure or explain exactly why the evidence is insufficient.

Confidentiality wins when the goals conflict. The sanitizer fails rather than publishing an ambiguous value.

## The sanitizer is an allowlist compiler

The sanitizer does not clean an entire log and declare it safe. It builds a new fixture from approved fields and selected evidence windows.

Processing order is fixed:

1. validate the sealed raw manifest and file hashes;
2. parse only supported JSON and UTF-8 text inputs;
3. select allowlisted records and evidence windows;
4. normalize identifiers consistently;
5. redact or reject sensitive values;
6. remove control sequences and encode content for structured output;
7. assign stable evidence IDs and citation locations;
8. validate fixture schemas and size limits;
9. run independent sensitive-data checks;
10. write a sanitized candidate and report outside the repository.

The sanitizer MUST be deterministic for the same raw bundle, configuration, and sanitizer version.

## Public input and evaluator truth are physically separate

The repository layout will separate model-visible fixture input from evaluator-only expected results:

```text
fixtures/
  public/
    link-pr-60-package-v1/
      fixture.json
      evidence.json
      SANITIZATION_REPORT.md
    link-pr-60-windows-smoke-v1/
      fixture.json
      evidence.json
      SANITIZATION_REPORT.md
eval/
  expected/
    link-pr-60-package-v1.json
    link-pr-60-windows-smoke-v1.json
```

The public demo build MUST use an explicit asset allowlist rooted at `fixtures/public/`. It MUST exclude `eval/expected/` by construction, not merely by prompt convention.

The Workflow, Agent, and Workers AI receive only `fixture.json` and `evidence.json`. Expected results are loaded only by offline or CI evaluation code after the diagnosis is complete.

## Fixture schema

`fixture.json` contains bounded investigation context:

```json
{
  "schema_version": 1,
  "fixture_id": "link-pr-60-package-v1",
  "source": {
    "repository": "gowtham0992/link",
    "pull_request": 60,
    "public_url": "https://github.com/gowtham0992/link/pull/60"
  },
  "run": {
    "event": "pull_request",
    "attempt": 1,
    "base_sha": "643e208adbbe2dfd1c91bf9e8305e6dec2b037a6",
    "head_sha": "d1b707d6da5f2331719e3e7d7fc70a0e6faff32c"
  },
  "focus": {
    "job": "package",
    "failed_step": "Build link-mcp"
  },
  "job_summary": [],
  "change_summary": [],
  "evidence_ids": []
}
```

The example defines shape, not final captured content. Fields not in the schema are rejected.

`evidence.json` is an array of independently citable items:

```json
[
  {
    "id": "E-PKG-001",
    "kind": "job_log",
    "title": "Wheel build fails from the generated sdist",
    "source": {
      "job": "package",
      "step": "Build link-mcp",
      "path": null,
      "original_line_start": 41,
      "original_line_end": 58
    },
    "sequence": 1,
    "content": "...",
    "redactions": {
      "path": 2,
      "email": 0,
      "url": 0,
      "credential": 0,
      "environment": 0
    }
  }
]
```

Rules:

- Evidence IDs are unique within a fixture and stable across repeated sanitizer runs.
- IDs contain no raw user, machine, or secret-derived value.
- `content` is plain text, never HTML.
- The UI must render it with text escaping; Markdown or HTML interpretation is not part of the fixture contract.
- `sequence` preserves causal order across excerpts.
- Locations refer to the raw source without exposing its local storage path.
- Redaction metadata contains counts and categories only, never original values.
- Every `fixture.json.evidence_ids` entry must exist exactly once in `evidence.json`.

## Expected-result schema

Expected results use a different tree and schema:

```json
{
  "schema_version": 1,
  "fixture_id": "link-pr-60-package-v1",
  "acceptable_outcomes": ["diagnosed"],
  "required_claims": [],
  "required_evidence_ids": [],
  "forbidden_claims": [],
  "review_notes": []
}
```

For the Windows fixture, `acceptable_outcomes` may contain only `insufficient_evidence` if the authenticated record does not support a defensible cause. Expected results must not invent a cause to make the demo look more capable.

Expected files:

- MUST NOT be referenced by `fixture.json`;
- MUST NOT be copied into the public Worker bundle;
- MUST NOT be stored in demo Agent state;
- MUST NOT be available through a public route;
- MUST be applied only after the model response is final.

## Selection rules retain only decision-relevant evidence

### Job and step context

Keep:

- every job name and conclusion;
- step names and conclusions for the focused failed job;
- failed-step order and bounded timing information;
- warnings only when they could affect the diagnosis or demonstrate rejected noise.

Drop:

- runner provisioning chatter;
- repeated progress output;
- unrelated successful-step bodies;
- post-job cleanup unless it failed or altered the conclusion.

### Log windows

- Select the failure line, traceback or assertion, and up to 25 relevant lines before and after it.
- Include setup/version lines only for tools or runtimes connected to a live hypothesis.
- Merge overlapping windows instead of duplicating text.
- Preserve original line ranges and relative order.
- A fixture should normally remain under 64 KiB of model-visible evidence and 400 sanitized log lines. Exceeding either limit requires a written exception in the sanitization report.
- A generic `Process completed with exit code 1` is preserved but labeled generic; it cannot alone support a root-cause claim.

### Source and diff context

- Repository-relative paths in the public Link repository may be retained.
- Include minimal relevant hunks rather than whole files.
- Each hunk records base/head identity and line location.
- Include at most 80 lines per source evidence item and 250 source lines per fixture unless review approves an exception.
- Binary content, generated bundles, vendored dependencies, lockfile bodies, and unrelated files are excluded by default.
- An absent or truncated GitHub patch is recorded as missing evidence, not treated as an unchanged file.

### Commit context

- Keep commit SHA, timestamp, and message only when the commit is relevant to the failed step or establishes the change sequence.
- Drop author and committer email addresses.
- Login names may be retained for this public Link fixture only when necessary for public provenance; they are not diagnostic evidence by default.
- Treat pull-request titles, bodies, and commit messages as untrusted text. Include only the portions needed to understand the release or failure, even when the source repository is public.

## Category-specific normalization

### Paths

Paths are handled by origin:

| Input | Output rule |
| --- | --- |
| Repository-relative path | Retain when it belongs to the frozen repository and is needed by an evidence item. |
| POSIX home path | Replace the home prefix with `<HOME>`. |
| Windows user profile | Replace the profile prefix with `<HOME>`. Preserve Windows separators when OS behavior matters. |
| Workspace checkout root | Replace with `<WORKSPACE>`. |
| Temporary directory | Replace with stable placeholders such as `<TEMP>/build-1`. |
| Runner tool-cache path | Replace the machine-specific prefix with `<TOOL_CACHE>`. |
| Path outside known roots | Replace the entire absolute prefix or fail when its role is unclear. |

Equivalent raw paths must map to the same placeholder within a fixture. A private replacement map containing original-to-placeholder mappings remains in the raw vault and never enters the repository.

Sanitization must preserve diagnostic suffixes. For example, a missing `.linkignore` path remains visible even when its temporary prefix becomes `<TEMP>`.

### Email addresses

- Replace all real email addresses with `<EMAIL:n>`, using stable numbering within the fixture.
- Do not retain an address merely because the repository is public.
- Documentation-only addresses under reserved example domains may remain when they are part of relevant source code and cannot identify a person.
- Remove surrounding display names when they add no diagnostic value.

### URLs

URLs are parsed structurally; they are never sanitized with string slicing alone.

- Reject URLs containing user-info credentials.
- Remove fragments and query strings by default.
- Remove every signed log-download URL in full, including its hostname and parameters, and replace it with `<SIGNED_LOG_URL>`.
- Public GitHub URLs under `github.com/gowtham0992/link` may remain without query or fragment data.
- Stable GitHub API paths may appear in private provenance, but public model input should prefer the human-facing source URL and evidence ID.
- Package and documentation URLs may retain scheme, host, and non-sensitive path only when diagnostically relevant.
- Normalize loopback hosts and ports to `<LOCAL_SERVICE>` unless a specific port caused the failure.
- Any unrecognized URL with a query parameter named like `token`, `key`, `sig`, `signature`, `credential`, `auth`, `expires`, or `x-amz-*` is rejected, not partially retained.

### Tokens and credentials

The sanitizer detects and removes:

- authorization and cookie header values;
- GitHub token families and other known provider prefixes;
- JWTs;
- PEM and SSH private keys;
- connection strings with credentials;
- signed URL parameters;
- password, secret, API-key, and token assignments;
- high-entropy opaque values outside an explicit safe allowlist;
- values already masked by GitHub as `***`.

Replacement labels describe the category, such as `<REDACTED:GITHUB_TOKEN>` or `<REDACTED:SIGNED_VALUE>`, but never length, prefix, or suffix. An uncertain candidate fails sanitization for review.

### Environment values

Full environment dumps are prohibited. The sanitizer constructs a new allowlisted environment summary.

Allowed fields are limited to:

- operating system family and published runner image label;
- architecture;
- language runtime name and version;
- directly relevant tool and dependency versions;
- shell family;
- boolean CI indicator.

Workspace paths use path normalization. All other environment names and values are dropped. Names that themselves reveal private infrastructure are not retained in the public sanitization report.

### Control and executable content

- Strip ANSI escape sequences and non-printing control characters except newline and tab.
- Reject NUL bytes and unsupported encodings.
- Preserve repository or log text that resembles instructions, but mark every evidence item as untrusted data when constructing the model prompt.
- Never evaluate shell fragments, workflow expressions, HTML, Markdown, or terminal control sequences during sanitization or replay.
- The public UI renders evidence as escaped text.

## Citation fidelity

Bar must be able to cite evidence without receiving the raw capture.

- Every material model claim must cite one or more evidence IDs.
- Evidence IDs resolve to a title, kind, ordered content, and source location.
- Sanitized line numbering is added for display while original line ranges remain metadata.
- Source-code items include repository-relative path, frozen SHA role (`base` or `head`), and original line range.
- Job-log items include job, step, and original line range.
- Normalization may change values but must not change event order, error text needed for diagnosis, filenames, tool versions, or the relationship between two evidence items.
- If required context cannot be retained safely, the item is omitted and `missing_evidence` records what category is unavailable and why.

The model is instructed to treat a missing evidence declaration as a reason to lower confidence or abstain, never as permission to fill the gap.

## Sanitization report

Each public fixture includes `SANITIZATION_REPORT.md` containing only safe metadata:

- sanitizer version and fixture schema version;
- source repository, PR, public URL, head/base SHAs, and focused job;
- list of included evidence IDs and why each was selected;
- counts of removals by category;
- list of omitted evidence categories;
- truncation or missing-evidence declarations;
- automated verification results;
- human review date and reviewer role, not reviewer email;
- candidate and promoted fixture hashes.

It MUST NOT contain replacement maps, raw snippets that were rejected, secret candidates, absolute private paths, signed URLs, or environment-variable inventories.

## Verification must prove absence, separation, and usefulness

A sanitized candidate cannot be promoted until all gates pass.

### 1. Schema and boundary validation

- Reject unknown fields and unexpected files.
- Reject symlinks, device files, archives, and binary content in the candidate.
- Confirm the candidate and raw vault are outside the repository.
- Confirm promotion targets only the intended `fixtures/public/<fixture-id>/` and `eval/expected/<fixture-id>.json` paths.

### 2. Deterministic secret detection

Scan the entire candidate for:

- known credential prefixes and private-key markers;
- authorization/cookie syntax;
- JWT structure;
- credential-bearing URLs;
- email addresses;
- absolute home, workspace, and temporary paths;
- disallowed environment-variable assignments;
- high-entropy opaque strings.

Zero unresolved matches are allowed.

### 3. Independent scanner

Run a maintained secret scanner, such as Gitleaks, against the candidate directory without relying on Git history. Zero findings are required. Its configuration may suppress only demonstrably safe fixture constants, and every suppression requires a comment and regression test.

### 4. Exact-value survivor check

During sanitization, collect discovered sensitive raw values into a private, memory-only or raw-vault deny set. Search the candidate bytes for exact survivors before writing the final report. The deny set itself must never be serialized into the candidate.

### 5. Canary tests

Tests inject representative secrets into a disposable copy of the raw fixture:

- GitHub token;
- JWT;
- PEM private key;
- credential-bearing URL;
- POSIX and Windows home paths;
- personal email;
- unapproved environment value;
- high-entropy opaque token.

Every canary must be removed or cause a fail-closed result. The tests must also prove that relevant values such as `.linkignore`, `Build link-mcp`, Windows path separators, and tool versions survive.

### 6. Expected-result isolation

- Build the exact public-demo asset manifest and assert that no `eval/expected` file is present.
- Search `fixture.json`, `evidence.json`, the demo bundle, and demo Agent seed state for required-claim phrases sourced only from expected results.
- Run diagnosis before loading expected results in evaluation.
- Deny public HTTP access to every evaluator path even if a deployment is misconfigured.

### 7. Citation validation

- Every referenced evidence ID exists exactly once.
- Every evidence location has the required job/step or path/SHA fields.
- Every expected required evidence ID exists in the public input while expected prose remains absent.
- A diagnosis containing an unknown evidence ID fails validation.

### 8. Clean-room replay

Copy only the candidate public fixture into a clean temporary directory with no credential and no raw-vault access. Run the same fixture loader used by the public demo. The real Workflow, demo Agent namespace, and Workers AI must be able to process that fixture without network access to GitHub.

The package fixture should retain enough evidence to support the checkout-versus-sdist diagnosis. The Windows fixture passes when Bar either cites a defensible cause or explicitly reports that the available evidence is insufficient.

### 9. Human review

A reviewer reads every candidate file and confirms:

- each included line changes the investigation;
- no private identity or infrastructure detail remains;
- replacements are consistent;
- citations remain understandable;
- no expected answer leaked into model input;
- uncertainty was preserved rather than edited into a stronger story.

Human approval does not override an automated security failure.

## Public-demo runtime constraints

Sanitized fixtures will use the real public-demo Workflow, separate Agent state, and Workers AI diagnosis. The deployment boundary is:

- build-time allowlisted fixture IDs only;
- no GitHub credential or GitHub API binding;
- no binding to the private Agent namespace or private Workflow;
- per-session Agent identity generated by the server, not accepted from a visitor;
- bounded chat input, Workflow starts, model calls, tokens, and session lifetime;
- rate limiting before starting a Workflow or invoking Workers AI;
- no repository-writing, workflow-rerun, arbitrary-fetch, or external notification tools;
- fixture state may be reset without affecting reviewed resolution memory in the private app.

Exact rate and model-call limits belong in the PRD and deployment configuration. Their absence does not permit an unlimited public deployment.

## Promotion and correction

- Promotion copies verified candidate bytes; it does not rerun transformations inside the repository.
- The promoted hashes must match the approved candidate hashes.
- Manual edits to promoted fixture evidence are prohibited. Regenerate from the sealed raw capture instead.
- A correction creates a new fixture revision and expected-result revision.
- Old fixture revisions may remain for reproducibility unless they contain sensitive data. A sensitive-data finding requires removal, credential rotation when applicable, and Git-history review.

## Non-goals

This specification does not define:

- the collector implementation;
- the sanitizer programming language;
- the model prompt;
- diagnosis scoring thresholds;
- live-investigation storage;
- Cloudflare Access policies;
- public-demo rate-limit values;
- automatic remediation.
