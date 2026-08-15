"""Build review-only sanitized fixtures from the frozen Link PR #60 capture."""

from __future__ import annotations

import difflib
import hashlib
import json
import math
import os
import re
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from bar_tools.collect_pr60 import (
    BASE_SHA,
    FAILED_JOBS,
    HEAD_SHA,
    OWNER,
    PULL_REQUEST,
    REPOSITORY,
    RUN_ATTEMPT,
    RUN_ID,
)


SANITIZER_VERSION = "0.1.0"
FIXTURE_SCHEMA_VERSION = 1
PUBLIC_URL = "https://github.com/gowtham0992/link/pull/60"

ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
GITHUB_TOKEN_RE = re.compile(r"\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b")
JWT_RE = re.compile(
    r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])"
)
PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.DOTALL,
)
URL_RE = re.compile(r"https?://[^\s<>\"']+")
ENV_ASSIGNMENT_RE = re.compile(r"(?m)^(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<value>[^\r\n]*)$")
OPAQUE_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9])")
ABSOLUTE_PATH_RE = re.compile(
    r"(?:/Users/[^/\s]+|/home/[^/\s]+|/private/tmp/[^\s]+|/tmp/[^\s]+|[A-Za-z]:\\+Users\\+[^\\\s]+|[A-Za-z]:\\+a\\+link\\+link)"
)

ALLOWED_ENVIRONMENT = {
    "CI",
    "RUNNER_ARCH",
    "RUNNER_OS",
}
ALLOWED_LONG_VALUES = {BASE_SHA, HEAD_SHA}
SUSPICIOUS_QUERY_NAMES = {
    "auth",
    "credential",
    "expires",
    "key",
    "sig",
    "signature",
    "token",
}


class SanitizationError(RuntimeError):
    """A fail-closed sanitization error that contains no raw value."""


class CandidateBoundaryError(SanitizationError):
    """The candidate output path violates the repository boundary."""


@dataclass
class SanitizationContext:
    email_numbers: dict[str, int] = field(default_factory=dict)
    discovered_sensitive_values: set[str] = field(default_factory=set)

    def email_placeholder(self, match: re.Match[str]) -> str:
        value = match.group(0)
        self.discovered_sensitive_values.add(value)
        if value not in self.email_numbers:
            self.email_numbers[value] = len(self.email_numbers) + 1
        return f"<EMAIL:{self.email_numbers[value]}>"


def _empty_counts() -> dict[str, int]:
    return {"path": 0, "email": 0, "url": 0, "credential": 0, "environment": 0}


def _replace_with_count(
    pattern: re.Pattern[str],
    replacement: str,
    text: str,
    counts: dict[str, int],
    category: str,
    context: SanitizationContext,
) -> str:
    def replace(match: re.Match[str]) -> str:
        counts[category] += 1
        context.discovered_sensitive_values.add(match.group(0))
        return replacement

    return pattern.sub(replace, text)


def _sanitize_url(
    match: re.Match[str],
    counts: dict[str, int],
    context: SanitizationContext,
) -> str:
    raw = match.group(0)
    trailing = ""
    while raw and raw[-1] in ".,);]":
        trailing = raw[-1] + trailing
        raw = raw[:-1]
    parsed = urlsplit(raw)
    query_names = {name.lower() for name, _ in parse_qsl(parsed.query, keep_blank_values=True)}
    suspicious_query = any(
        name in SUSPICIOUS_QUERY_NAMES or name.startswith("x-amz-") for name in query_names
    )
    if parsed.username or parsed.password:
        counts["credential"] += 1
        context.discovered_sensitive_values.add(raw)
        return "<REDACTED:CREDENTIAL_URL>" + trailing
    if suspicious_query:
        counts["credential"] += 1
        context.discovered_sensitive_values.add(raw)
        return "<SIGNED_LOG_URL>" + trailing
    normalized = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    if normalized != raw:
        counts["url"] += 1
        context.discovered_sensitive_values.add(raw)
    return normalized + trailing


def sanitize_text(
    source: str,
    *,
    context: SanitizationContext | None = None,
) -> tuple[str, dict[str, int], set[str]]:
    context = context or SanitizationContext()
    counts = _empty_counts()
    text = ANSI_RE.sub("", source)
    text = CONTROL_RE.sub("", text)
    text = _replace_with_count(
        PRIVATE_KEY_RE,
        "<REDACTED:PRIVATE_KEY>",
        text,
        counts,
        "credential",
        context,
    )
    text = URL_RE.sub(lambda match: _sanitize_url(match, counts, context), text)
    text = _replace_with_count(
        GITHUB_TOKEN_RE,
        "<REDACTED:GITHUB_TOKEN>",
        text,
        counts,
        "credential",
        context,
    )
    text = _replace_with_count(
        JWT_RE,
        "<REDACTED:JWT>",
        text,
        counts,
        "credential",
        context,
    )

    def replace_email(match: re.Match[str]) -> str:
        counts["email"] += 1
        return context.email_placeholder(match)

    text = EMAIL_RE.sub(replace_email, text)

    path_rules = (
        (re.compile(r"(?i)/home/runner/work/link/link(?=/|\b)"), "<WORKSPACE>"),
        (re.compile(r"(?i)[A-Za-z]:\\+a\\+link\\+link(?=\\|\b)"), "<WORKSPACE>"),
        (re.compile(r"(?i)/opt/hostedtoolcache(?=/|\b)"), "<TOOL_CACHE>"),
        (re.compile(r"(?i)[A-Za-z]:\\+hostedtoolcache(?=\\|\b)"), "<TOOL_CACHE>"),
        (re.compile(r"(?i)/Users/[^/\s]+"), "<HOME>"),
        (re.compile(r"(?i)/home/[^/\s]+"), "<HOME>"),
        (re.compile(r"(?i)[A-Za-z]:\\+Users\\+[^\\\s]+"), "<HOME>"),
        (re.compile(r"(?i)/private/tmp/[^/\s]+"), "<TEMP>"),
        (re.compile(r"(?i)/tmp/[^/\s]+"), "<TEMP>"),
    )
    for pattern, replacement in path_rules:
        text = _replace_with_count(
            pattern,
            replacement,
            text,
            counts,
            "path",
            context,
        )

    def replace_environment(match: re.Match[str]) -> str:
        name = match.group("name")
        if name in ALLOWED_ENVIRONMENT:
            return match.group(0)
        counts["environment"] += 1
        context.discovered_sensitive_values.add(match.group("value"))
        return f"{name}=<REDACTED:ENVIRONMENT>"

    text = ENV_ASSIGNMENT_RE.sub(replace_environment, text)

    def replace_opaque(match: re.Match[str]) -> str:
        value = match.group(0)
        if value in ALLOWED_LONG_VALUES:
            return value
        frequencies = Counter(value)
        entropy = -sum(
            (count / len(value)) * math.log2(count / len(value))
            for count in frequencies.values()
        )
        character_classes = sum(
            bool(pattern.search(value))
            for pattern in (re.compile(r"[a-z]"), re.compile(r"[A-Z]"), re.compile(r"[0-9]"))
        )
        is_long_hex = len(value) >= 48 and bool(re.fullmatch(r"[A-Fa-f0-9]+", value))
        if not (is_long_hex or (character_classes >= 3 and entropy >= 4.2)):
            return value
        counts["credential"] += 1
        context.discovered_sensitive_values.add(value)
        return "<REDACTED:OPAQUE_VALUE>"

    text = OPAQUE_RE.sub(replace_opaque, text)
    return text, counts, set(context.discovered_sensitive_values)


def verify_safe_text(text: str) -> None:
    forbidden_patterns = (
        GITHUB_TOKEN_RE,
        JWT_RE,
        PRIVATE_KEY_RE,
        EMAIL_RE,
        ABSOLUTE_PATH_RE,
        ANSI_RE,
        CONTROL_RE,
    )
    if any(pattern.search(text) for pattern in forbidden_patterns):
        raise SanitizationError("candidate contains a forbidden sensitive-data pattern")
    for match in URL_RE.finditer(text):
        parsed = urlsplit(match.group(0))
        names = {name.lower() for name, _ in parse_qsl(parsed.query, keep_blank_values=True)}
        if parsed.username or parsed.password or any(
            name in SUSPICIOUS_QUERY_NAMES or name.startswith("x-amz-") for name in names
        ):
            raise SanitizationError("candidate contains a credential-bearing URL")


def run_gitleaks(
    candidate_public_root: Path,
    *,
    runner: Any = subprocess.run,
) -> str:
    version_result = runner(
        ["gitleaks", "version"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if version_result.returncode != 0:
        raise SanitizationError("Gitleaks is required for candidate verification")
    version = version_result.stdout.decode("utf-8").strip()
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
        raise SanitizationError("Gitleaks returned an unexpected version")
    scan_result = runner(
        [
            "gitleaks",
            "dir",
            str(candidate_public_root),
            "--redact=100",
            "--no-banner",
            "--no-color",
            "--log-level",
            "error",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if scan_result.returncode != 0:
        raise SanitizationError("Gitleaks rejected the sanitized candidate")
    return version


def validate_candidate_directory(candidate: Path, repository_root: Path) -> Path:
    repository = repository_root.resolve(strict=True)
    destination = candidate.expanduser().resolve(strict=False)
    if destination == repository or destination.is_relative_to(repository):
        raise CandidateBoundaryError("candidate output must be outside the Bar worktree")
    if destination.exists():
        raise CandidateBoundaryError("candidate output directory must not already exist")
    return destination


def _validate_raw_bundle(raw_root: Path, repository_root: Path) -> dict[str, Any]:
    raw = raw_root.resolve(strict=True)
    repository = repository_root.resolve(strict=True)
    if raw == repository or raw.is_relative_to(repository):
        raise SanitizationError("raw bundle is inside the Bar worktree")
    if raw.is_symlink() or not (raw / "BAR_RAW_EVIDENCE_DO_NOT_COMMIT").is_file():
        raise SanitizationError("raw bundle marker is missing")
    manifest_body = (raw / "manifest.json").read_bytes()
    expected_manifest_hash = (raw / "manifest.sha256").read_text("utf-8").split()[0]
    if hashlib.sha256(manifest_body).hexdigest() != expected_manifest_hash:
        raise SanitizationError("raw manifest hash mismatch")
    manifest = json.loads(manifest_body)
    if manifest.get("capture_status") != "complete":
        raise SanitizationError("raw capture is incomplete")
    for entry in manifest.get("files", []):
        relative = Path(entry["path"])
        path = (raw / relative).resolve(strict=True)
        if not path.is_relative_to(raw) or path.is_symlink() or not path.is_file():
            raise SanitizationError("raw manifest contains an invalid path")
        body = path.read_bytes()
        if len(body) != entry["byte_length"]:
            raise SanitizationError("raw file length mismatch")
        if hashlib.sha256(body).hexdigest() != entry["sha256"]:
            raise SanitizationError("raw file hash mismatch")
    capture = json.loads((raw / "capture.json").read_text("utf-8"))
    if (
        capture.get("repository") != {"owner": OWNER, "name": REPOSITORY, "visibility": "public"}
        or capture.get("pull_request") != PULL_REQUEST
        or capture.get("workflow_run_id") != RUN_ID
        or capture.get("run_attempt") != RUN_ATTEMPT
        or capture.get("base_sha") != BASE_SHA
        or capture.get("head_sha") != HEAD_SHA
    ):
        raise SanitizationError("raw capture identity mismatch")
    return manifest


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text("utf-8"))


def _decode_log(path: Path) -> str:
    try:
        return path.read_text("utf-8")
    except UnicodeDecodeError as error:
        raise SanitizationError("raw log is not UTF-8") from error


def _select_window(
    text: str,
    weighted_patterns: Iterable[tuple[str, int]],
    *,
    before: int,
    after: int,
) -> tuple[str, int, int]:
    lines = text.splitlines()
    if not lines:
        raise SanitizationError("required log is empty")
    lowered_patterns = [(pattern.lower(), weight) for pattern, weight in weighted_patterns]
    scored: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        lowered = line.lower()
        score = sum(weight for pattern, weight in lowered_patterns if pattern in lowered)
        if score:
            scored.append((score, index))
    if not scored:
        anchor = len(lines) - 1
    else:
        _, anchor = max(scored, key=lambda item: (item[0], item[1]))
    start = max(0, anchor - before)
    end = min(len(lines), anchor + after + 1)
    for index in range(anchor, end):
        if "process completed with exit code" in lines[index].lower():
            end = index + 1
            break
    return "\n".join(lines[start:end]) + "\n", start + 1, end


def _source_window(
    text: str,
    patterns: Iterable[str],
    *,
    before: int = 6,
    after: int = 14,
) -> tuple[str, int, int]:
    weighted = [(pattern, 1) for pattern in patterns]
    return _select_window(text, weighted, before=before, after=after)


def _diff_window(
    base_text: str,
    head_text: str,
    path: str,
    patterns: Iterable[str],
) -> tuple[str, int, int]:
    diff_lines = list(
        difflib.unified_diff(
            base_text.splitlines(),
            head_text.splitlines(),
            fromfile=f"base/{path}",
            tofile=f"head/{path}",
            n=5,
            lineterm="",
        )
    )
    if not diff_lines:
        raise SanitizationError("required source comparison has no changes")
    selected, start, end = _source_window("\n".join(diff_lines), patterns, before=8, after=18)
    return selected, start, end


def _add_counts(total: dict[str, int], addition: dict[str, int]) -> None:
    for category, count in addition.items():
        total[category] += count


def _job_summary(jobs: dict[str, Any], *, focused_job_id: int) -> list[dict[str, Any]]:
    return [
        {
            "name": job.get("name"),
            "conclusion": job.get("conclusion"),
            "steps": [
                {"name": step.get("name"), "conclusion": step.get("conclusion")}
                for step in job.get("steps", [])
            ]
            if job.get("id") == focused_job_id
            else [],
        }
        for job in jobs.get("jobs", [])
    ]


def _failed_step(jobs: dict[str, Any], job_id: int) -> str:
    for job in jobs.get("jobs", []):
        if job.get("id") == job_id:
            failed = [step.get("name") for step in job.get("steps", []) if step.get("conclusion") == "failure"]
            return failed[0] if failed else "unknown failed step"
    raise SanitizationError("focused job is absent from jobs evidence")


def _sanitize_evidence(
    *,
    evidence_id: str,
    kind: str,
    title: str,
    raw_content: str,
    source: dict[str, Any],
    sequence: int,
    context: SanitizationContext,
    total_counts: dict[str, int],
) -> dict[str, Any]:
    content, counts, _ = sanitize_text(raw_content, context=context)
    verify_safe_text(content)
    _add_counts(total_counts, counts)
    return {
        "id": evidence_id,
        "kind": kind,
        "title": title,
        "source": source,
        "sequence": sequence,
        "content": content,
        "redactions": counts,
    }


def _write_private_file(path: Path, body: bytes) -> None:
    missing_directories: list[Path] = []
    cursor = path.parent
    while not cursor.exists():
        missing_directories.append(cursor)
        cursor = cursor.parent
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    for directory in missing_directories:
        os.chmod(directory, 0o700)
    path.write_bytes(body)
    os.chmod(path, 0o600)


def _write_json(path: Path, value: Any) -> None:
    _write_private_file(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def _hash_model_input(fixture: dict[str, Any], evidence: list[dict[str, Any]]) -> str:
    body = json.dumps(
        {"fixture": fixture, "evidence": evidence},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _report(
    fixture: dict[str, Any],
    evidence: list[dict[str, Any]],
    counts: dict[str, int],
    model_input_hash: str,
    omitted: list[str],
    scanner_version: str | None = None,
) -> str:
    included = "\n".join(f"- `{item['id']}`: {item['title']}" for item in evidence)
    removals = "\n".join(f"- {name}: {value}" for name, value in counts.items())
    omitted_lines = "\n".join(f"- {item}" for item in omitted) or "- None"
    scanner_status = (
        f"passed (Gitleaks {scanner_version}, full output redaction)"
        if scanner_version
        else "pending external Gitleaks pass"
    )
    return f"""# Sanitization Report

- Status: automated checks passed; human review pending
- Sanitizer version: {SANITIZER_VERSION}
- Fixture schema version: {FIXTURE_SCHEMA_VERSION}
- Fixture: `{fixture['fixture_id']}`
- Source: `{OWNER}/{REPOSITORY}` PR #{PULL_REQUEST}
- Public source: {PUBLIC_URL}
- Base SHA: `{BASE_SHA}`
- Head SHA: `{HEAD_SHA}`
- Focused job: `{fixture['focus']['job']}`
- Model-input SHA-256: `{model_input_hash}`
- Promoted fixture SHA-256: pending

## Included evidence

{included}

## Redactions

{removals}

## Omitted or missing evidence

{omitted_lines}

## Automated verification

- Raw manifest and every captured file hash verified.
- Candidate boundary, schema shape, text encoding, and citation references verified.
- Known credential, email, absolute-path, URL, environment, control-sequence, and opaque-value checks passed.
- Exact discovered sensitive-value survivor check passed.
- Expected results are outside the public model-input tree.
- Independent secret scanner: {scanner_status}.
- Human review: pending.
"""


def _verify_fixture(fixture: dict[str, Any], evidence: list[dict[str, Any]]) -> None:
    ids = [item["id"] for item in evidence]
    if len(ids) != len(set(ids)) or fixture.get("evidence_ids") != ids:
        raise SanitizationError("fixture evidence citations are inconsistent")
    if any(item["sequence"] != index for index, item in enumerate(evidence, start=1)):
        raise SanitizationError("fixture evidence sequence is inconsistent")
    if sum(len(item["content"].splitlines()) for item in evidence) > 400:
        raise SanitizationError("fixture exceeds the sanitized line limit")
    encoded_size = len(json.dumps(evidence).encode("utf-8"))
    if encoded_size > 64 * 1024:
        raise SanitizationError("fixture exceeds the model-visible evidence limit")


def _assert_no_exact_survivors(candidate_bytes: bytes, values: set[str]) -> None:
    for value in values:
        if len(value) >= 6 and value.encode("utf-8", errors="ignore") in candidate_bytes:
            raise SanitizationError("candidate retained an exact discovered sensitive value")


def sanitize_pr60(raw_root: Path, candidate_root: Path, repository_root: Path) -> Path:
    destination = validate_candidate_directory(candidate_root, repository_root)
    _validate_raw_bundle(raw_root, repository_root)
    raw = raw_root.resolve(strict=True)
    destination.mkdir(mode=0o700, parents=True)
    os.chmod(destination, 0o700)
    _write_private_file(
        destination / "BAR_SANITIZED_CANDIDATE_NOT_APPROVED",
        b"Sanitized review candidate. Do not promote without human approval.\n",
    )

    jobs = _read_json(raw / "github/jobs.json")
    pull_files = _read_json(raw / "github/pull-files.json")

    workflow_head = (raw / "github/contents/head/.github/workflows/ci.yml").read_text("utf-8")
    pyproject_base = (raw / "github/contents/base/mcp_package/pyproject.toml").read_text("utf-8")
    pyproject_head = (raw / "github/contents/head/mcp_package/pyproject.toml").read_text("utf-8")
    windows_eval_head = (raw / "github/contents/head/scripts/eval_token_economics.py").read_text("utf-8")
    windows_guard_test_head = (raw / "github/contents/head/tests/test_guard_core.py").read_text("utf-8")
    windows_token_test_head = (raw / "github/contents/head/tests/test_token_economics.py").read_text("utf-8")

    fixture_specs = (
        {
            "fixture_id": "link-pr-60-package-v1",
            "job_id": 94347441040,
            "job": "package",
            "log": "package.log",
            "prefix": "E-PKG",
            "patterns": (
                (".linkignore", 120),
                ("filenotfounderror", 100),
                ("no such file", 90),
                ("subprocess-exited-with-error", 60),
                ("error", 30),
                ("process completed with exit code", 10),
            ),
            "acceptable": ["diagnosed"],
        },
        {
            "fixture_id": "link-pr-60-windows-smoke-v1",
            "job_id": 94347441096,
            "job": "windows-smoke",
            "log": "windows-smoke.log",
            "prefix": "E-WIN",
            "patterns": (
                ("traceback", 120),
                ("assertionerror", 110),
                ("##[error]", 100),
                ("error:", 90),
                ("failed", 80),
                ("exception", 70),
                ("process completed with exit code", 20),
            ),
            "acceptable": ["insufficient_evidence"],
        },
    )

    all_discovered_values: set[str] = set()
    public_paths: list[Path] = []
    report_records: list[tuple[Path, dict[str, Any], list[dict[str, Any]], dict[str, int], str, list[str]]] = []
    for spec in fixture_specs:
        context = SanitizationContext()
        counts = _empty_counts()
        evidence: list[dict[str, Any]] = []
        job_summary = _job_summary(jobs, focused_job_id=spec["job_id"])
        relevant_paths = (
            {".github/workflows/ci.yml", "mcp_package/pyproject.toml"}
            if spec["job"] == "package"
            else {
                ".github/workflows/ci.yml",
                "scripts/eval_token_economics.py",
                "tests/test_guard_core.py",
                "tests/test_token_economics.py",
            }
        )
        change_summary = [
            {
                "path": item.get("filename"),
                "status": item.get("status"),
                "additions": item.get("additions"),
                "deletions": item.get("deletions"),
            }
            for item in pull_files
            if item.get("filename") in relevant_paths
        ]
        failed_step = _failed_step(jobs, spec["job_id"])
        log_text = _decode_log(raw / "github/logs" / spec["log"])
        log_window, log_start, log_end = _select_window(
            log_text,
            spec["patterns"],
            before=18,
            after=35,
        )
        evidence.append(
            _sanitize_evidence(
                evidence_id=f"{spec['prefix']}-001",
                kind="job_log",
                title=f"Failure window from {spec['job']} job",
                raw_content=log_window,
                source={
                    "job": spec["job"],
                    "step": failed_step,
                    "path": None,
                    "sha_role": None,
                    "original_line_start": log_start,
                    "original_line_end": log_end,
                },
                sequence=1,
                context=context,
                total_counts=counts,
            )
        )

        omitted: list[str] = []
        if spec["job"] == "package":
            diff, diff_start, diff_end = _diff_window(
                pyproject_base,
                pyproject_head,
                "mcp_package/pyproject.toml",
                (".linkignore", "force-include", "sdist", "wheel"),
            )
            evidence.append(
                _sanitize_evidence(
                    evidence_id="E-PKG-002",
                    kind="source_diff",
                    title="Packaging configuration change",
                    raw_content=diff,
                    source={
                        "job": None,
                        "step": None,
                        "path": "mcp_package/pyproject.toml",
                        "sha_role": "base_to_head",
                        "original_line_start": diff_start,
                        "original_line_end": diff_end,
                    },
                    sequence=2,
                    context=context,
                    total_counts=counts,
                )
            )
            sdist_source, sdist_start, sdist_end = _source_window(
                pyproject_head,
                ("[tool.hatch.build.targets.sdist]", "exclude = ["),
                before=2,
                after=24,
            )
            evidence.append(
                _sanitize_evidence(
                    evidence_id="E-PKG-003",
                    kind="source",
                    title="Source distribution configuration",
                    raw_content=sdist_source,
                    source={
                        "job": None,
                        "step": None,
                        "path": "mcp_package/pyproject.toml",
                        "sha_role": "head",
                        "original_line_start": sdist_start,
                        "original_line_end": sdist_end,
                    },
                    sequence=3,
                    context=context,
                    total_counts=counts,
                )
            )
            workflow, workflow_start, workflow_end = _source_window(
                workflow_head,
                ("package:", "python -m build", "mcp_package"),
                before=8,
                after=20,
            )
            evidence.append(
                _sanitize_evidence(
                    evidence_id="E-PKG-004",
                    kind="source",
                    title="Package job workflow commands",
                    raw_content=workflow,
                    source={
                        "job": "package",
                        "step": failed_step,
                        "path": ".github/workflows/ci.yml",
                        "sha_role": "head",
                        "original_line_start": workflow_start,
                        "original_line_end": workflow_end,
                    },
                    sequence=4,
                    context=context,
                    total_counts=counts,
                )
            )
        else:
            workflow, workflow_start, workflow_end = _source_window(
                workflow_head,
                ("windows-smoke:", "windows", "smoke"),
                before=6,
                after=24,
            )
            evidence.append(
                _sanitize_evidence(
                    evidence_id="E-WIN-002",
                    kind="source",
                    title="Windows smoke workflow commands",
                    raw_content=workflow,
                    source={
                        "job": "windows-smoke",
                        "step": failed_step,
                        "path": ".github/workflows/ci.yml",
                        "sha_role": "head",
                        "original_line_start": workflow_start,
                        "original_line_end": workflow_end,
                    },
                    sequence=2,
                    context=context,
                    total_counts=counts,
                )
            )
            eval_source, eval_start, eval_end = _source_window(
                windows_eval_head,
                ("TemporaryDirectory", "page-fts-v1.sqlite", "build"),
                before=8,
                after=18,
            )
            evidence.append(
                _sanitize_evidence(
                    evidence_id="E-WIN-003",
                    kind="source",
                    title="Token economics evaluator cleanup context",
                    raw_content=eval_source,
                    source={
                        "job": "windows-smoke",
                        "step": failed_step,
                        "path": "scripts/eval_token_economics.py",
                        "sha_role": "head",
                        "original_line_start": eval_start,
                        "original_line_end": eval_end,
                    },
                    sequence=3,
                    context=context,
                    total_counts=counts,
                )
            )
            guard_source, guard_start, guard_end = _source_window(
                windows_guard_test_head,
                ("page-fts-v1.sqlite", "TemporaryDirectory", "McpGuardTests"),
                before=8,
                after=18,
            )
            evidence.append(
                _sanitize_evidence(
                    evidence_id="E-WIN-004",
                    kind="source",
                    title="Guard test temporary-directory context",
                    raw_content=guard_source,
                    source={
                        "job": "windows-smoke",
                        "step": failed_step,
                        "path": "tests/test_guard_core.py",
                        "sha_role": "head",
                        "original_line_start": guard_start,
                        "original_line_end": guard_end,
                    },
                    sequence=4,
                    context=context,
                    total_counts=counts,
                )
            )
            token_source, token_start, token_end = _source_window(
                windows_token_test_head,
                ("test_packets_stay_bounded_and_plateau", "eval_token_economics"),
                before=6,
                after=14,
            )
            evidence.append(
                _sanitize_evidence(
                    evidence_id="E-WIN-005",
                    kind="source",
                    title="Token economics failing test invocation",
                    raw_content=token_source,
                    source={
                        "job": "windows-smoke",
                        "step": failed_step,
                        "path": "tests/test_token_economics.py",
                        "sha_role": "head",
                        "original_line_start": token_start,
                        "original_line_end": token_end,
                    },
                    sequence=5,
                    context=context,
                    total_counts=counts,
                )
            )
            omitted.append(
                "The evidence identifies a locked SQLite file and affected call paths, but may not prove which component retains the handle."
            )

        fixture = {
            "schema_version": FIXTURE_SCHEMA_VERSION,
            "fixture_id": spec["fixture_id"],
            "source": {
                "repository": f"{OWNER}/{REPOSITORY}",
                "pull_request": PULL_REQUEST,
                "public_url": PUBLIC_URL,
            },
            "run": {
                "event": "pull_request",
                "attempt": RUN_ATTEMPT,
                "base_sha": BASE_SHA,
                "head_sha": HEAD_SHA,
            },
            "focus": {"job": spec["job"], "failed_step": failed_step},
            "job_summary": job_summary,
            "change_summary": change_summary,
            "missing_evidence": omitted,
            "evidence_ids": [item["id"] for item in evidence],
        }
        _verify_fixture(fixture, evidence)
        fixture_dir = destination / "public" / spec["fixture_id"]
        fixture_path = fixture_dir / "fixture.json"
        evidence_path = fixture_dir / "evidence.json"
        _write_json(fixture_path, fixture)
        _write_json(evidence_path, evidence)
        model_input_hash = _hash_model_input(fixture, evidence)
        report = _report(fixture, evidence, counts, model_input_hash, omitted)
        verify_safe_text(report)
        report_path = fixture_dir / "SANITIZATION_REPORT.md"
        _write_private_file(report_path, report.encode("utf-8"))
        public_paths.extend((fixture_path, evidence_path, report_path))
        report_records.append((report_path, fixture, evidence, counts, model_input_hash, omitted))

        if spec["job"] == "package":
            expected = {
                "schema_version": 1,
                "fixture_id": spec["fixture_id"],
                "acceptable_outcomes": spec["acceptable"],
                "required_claims": [
                    "The package configuration references .linkignore, but the wheel build cannot find it in the generated source distribution."
                ],
                "required_evidence_ids": ["E-PKG-001", "E-PKG-002", "E-PKG-003", "E-PKG-004"],
                "forbidden_claims": ["The failure is caused by a GitHub outage."],
                "review_notes": ["Require a causal explanation grounded in the log and packaging configuration."],
            }
        else:
            expected = {
                "schema_version": 1,
                "fixture_id": spec["fixture_id"],
                "acceptable_outcomes": ["diagnosed"],
                "required_claims": [
                    "Windows cleanup cannot delete page-fts-v1.sqlite because another process still holds the file open."
                ],
                "required_evidence_ids": ["E-WIN-001", "E-WIN-003"],
                "forbidden_claims": ["The evidence proves the exact component that retains the SQLite handle."],
                "review_notes": [
                    "A high-confidence symptom-level diagnosis is supported; require explicit uncertainty about the handle owner and exact fix."
                ],
            }
        _write_json(destination / "expected" / f"{spec['fixture_id']}.json", expected)
        all_discovered_values.update(context.discovered_sensitive_values)

    public_bytes = b"".join(path.read_bytes() for path in public_paths)
    _assert_no_exact_survivors(public_bytes, all_discovered_values)
    for path in public_paths:
        verify_safe_text(path.read_text("utf-8"))
        if path.is_symlink() or not path.is_file():
            raise SanitizationError("candidate contains an invalid public file")
    if any("expected" in path.parts for path in public_paths):
        raise SanitizationError("expected results entered the public model-input tree")
    scanner_version = run_gitleaks(destination / "public")
    for report_path, fixture, evidence, counts, model_input_hash, omitted in report_records:
        final_report = _report(
            fixture,
            evidence,
            counts,
            model_input_hash,
            omitted,
            scanner_version=scanner_version,
        )
        verify_safe_text(final_report)
        _write_private_file(report_path, final_report.encode("utf-8"))
    if run_gitleaks(destination / "public") != scanner_version:
        raise SanitizationError("Gitleaks version changed during candidate verification")
    final_public_bytes = b"".join(path.read_bytes() for path in public_paths)
    _assert_no_exact_survivors(final_public_bytes, all_discovered_values)
    for path in public_paths:
        verify_safe_text(path.read_text("utf-8"))
    return destination
