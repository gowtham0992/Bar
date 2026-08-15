# Sanitization report: link-pr-60-package-regression-v1

This is an explicitly synthetic replay scenario derived from the already
sanitized `link-pr-60-package-v1` fixture. It is not a second captured GitHub
Actions run and must not be presented as one.

The scenario preserves the same failure family while changing the job,
failed step, log window, artifact evidence, workflow command, and evidence
IDs. It contains no raw authenticated GitHub response or credential-bearing
material.

Checks applied:

- All paths are repository-relative or use the `<TEMP>` placeholder.
- No email addresses, credential patterns, private URLs, or environment
  values are present.
- The public GitHub URL is allowlisted by the evidence contract.
- Expected diagnosis claims are stored only under `eval/expected/` and are
  not imported into application code.
- Each factual input has a distinct `E-PKG-R2-*` ID so the model can cite
  only evidence from this current replay.
