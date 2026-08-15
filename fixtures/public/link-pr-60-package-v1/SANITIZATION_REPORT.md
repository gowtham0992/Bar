# Sanitization Report

- Status: approved for promotion
- Sanitizer version: 0.1.0
- Fixture schema version: 1
- Fixture: `link-pr-60-package-v1`
- Source: `gowtham0992/link` PR #60
- Public source: https://github.com/gowtham0992/link/pull/60
- Base SHA: `643e208adbbe2dfd1c91bf9e8305e6dec2b037a6`
- Head SHA: `d1b707d6da5f2331719e3e7d7fc70a0e6faff32c`
- Focused job: `package`
- Model-input SHA-256: `72c6b97a6e78a45aae69a36a9f4d1293c3abcf38dd5c11779b96eb200419e33e`
- Promoted fixture SHA-256: `72c6b97a6e78a45aae69a36a9f4d1293c3abcf38dd5c11779b96eb200419e33e`

## Included evidence

- `E-PKG-001`: Failure window from package job
- `E-PKG-002`: Packaging configuration change
- `E-PKG-003`: Source distribution configuration
- `E-PKG-004`: Package job workflow commands

## Redactions

- path: 10
- email: 0
- url: 0
- credential: 0
- environment: 0

## Omitted or missing evidence

- None

## Automated verification

- Raw manifest and every captured file hash verified.
- Candidate boundary, schema shape, text encoding, and citation references verified.
- Known credential, email, absolute-path, URL, environment, control-sequence, and opaque-value checks passed.
- Exact discovered sensitive-value survivor check passed.
- Expected results are outside the public model-input tree.
- Independent secret scanner: passed (Gitleaks 8.30.1, full output redaction).
- Human review: approved on 2026-08-13 by the project owner.
