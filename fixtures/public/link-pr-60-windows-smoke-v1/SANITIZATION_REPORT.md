# Sanitization Report

- Status: approved for promotion
- Sanitizer version: 0.1.0
- Fixture schema version: 1
- Fixture: `link-pr-60-windows-smoke-v1`
- Source: `gowtham0992/link` PR #60
- Public source: https://github.com/gowtham0992/link/pull/60
- Base SHA: `643e208adbbe2dfd1c91bf9e8305e6dec2b037a6`
- Head SHA: `d1b707d6da5f2331719e3e7d7fc70a0e6faff32c`
- Focused job: `windows-smoke`
- Model-input SHA-256: `c516ab9c48db7da755462b386c44090de9dca724562305f9fc3a59cf712c0676`
- Promoted fixture SHA-256: `c516ab9c48db7da755462b386c44090de9dca724562305f9fc3a59cf712c0676`

## Included evidence

- `E-WIN-001`: Failure window from windows-smoke job
- `E-WIN-002`: Windows smoke workflow commands
- `E-WIN-003`: Token economics evaluator cleanup context
- `E-WIN-004`: Guard test temporary-directory context
- `E-WIN-005`: Token economics failing test invocation

## Redactions

- path: 19
- email: 0
- url: 0
- credential: 0
- environment: 0

## Omitted or missing evidence

- The evidence identifies a locked SQLite file and affected call paths, but may not prove which component retains the handle.

## Automated verification

- Raw manifest and every captured file hash verified.
- Candidate boundary, schema shape, text encoding, and citation references verified.
- Known credential, email, absolute-path, URL, environment, control-sequence, and opaque-value checks passed.
- Exact discovered sensitive-value survivor check passed.
- Expected results are outside the public model-input tree.
- Independent secret scanner: passed (Gitleaks 8.30.1, full output redaction).
- Human review: approved on 2026-08-13 by the project owner.
