"""Capture the fixed GitHub evidence set for Link pull request 60.

This intentionally is not a general GitHub collector. It accepts only an
output directory; every repository, run, job, and SHA identifier is frozen
below. The GitHub token is read from macOS Keychain and passed to ``gh`` only
through the child process environment.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote


API_VERSION = "2026-03-10"
ACCEPT = "application/vnd.github+json"
OWNER = "gowtham0992"
REPOSITORY = "link"
PULL_REQUEST = 60
RUN_ID = 31668261705
RUN_ATTEMPT = 1
BASE_SHA = "643e208adbbe2dfd1c91bf9e8305e6dec2b037a6"
HEAD_SHA = "d1b707d6da5f2331719e3e7d7fc70a0e6faff32c"
FAILED_JOBS = {
    94347441040: ("package", "package.log"),
    94347441096: ("windows-smoke", "windows-smoke.log"),
}
KEYCHAIN_ACCOUNT = OWNER
KEYCHAIN_SERVICE = "dev.bar.github.link"
COLLECTOR_VERSION = "0.1.0"
PAGE_SIZE = 100

SOURCE_SEEDS = {
    ".github/workflows/ci.yml": "workflow definition",
    "mcp_package/pyproject.toml": "package build configuration",
    "mcp_package/link_core/demo.py": "package source named in the planned investigation",
    "tests/test_installers.py": "installer behavior exercised by CI",
    "scripts/eval_token_economics.py": "Windows traceback source",
    "tests/test_guard_core.py": "Windows failing test source",
    "tests/test_token_economics.py": "Windows failing test source",
}


class CollectorError(RuntimeError):
    """A fail-closed collector error safe to show without raw evidence."""


class OutputBoundaryError(CollectorError):
    """The requested raw output directory violates the repository boundary."""


Runner = Callable[..., subprocess.CompletedProcess[bytes]]


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def validate_output_directory(output: Path, repository_root: Path) -> Path:
    repository = repository_root.resolve(strict=True)
    candidate = output.expanduser().resolve(strict=False)
    if candidate == repository or candidate.is_relative_to(repository):
        raise OutputBoundaryError("raw output must be outside the Bar worktree")
    if candidate.exists():
        raise OutputBoundaryError("raw output directory must not already exist")
    return candidate


def load_keychain_token(*, runner: Runner = subprocess.run) -> str:
    result = runner(
        [
            "security",
            "find-generic-password",
            "-a",
            KEYCHAIN_ACCOUNT,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise CollectorError("the dedicated GitHub Keychain item is unavailable")
    token = result.stdout.decode("utf-8").strip()
    if not token.startswith("github_pat_"):
        raise CollectorError("the Keychain item is not a fine-grained GitHub token")
    return token


class GitHubClient:
    def __init__(self, token: str, *, runner: Runner = subprocess.run) -> None:
        if not token.startswith("github_pat_"):
            raise CollectorError("refusing a non-fine-grained GitHub token")
        self._token = token
        self._runner = runner

    def get_bytes(self, endpoint: str, *, allow_escape_sequences: bool = False) -> bytes:
        environment = os.environ.copy()
        for variable in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"):
            environment.pop(variable, None)
        environment["GH_TOKEN"] = self._token
        arguments = [
            "gh",
            "api",
            "--method",
            "GET",
            "-H",
            f"Accept: {ACCEPT}",
            "-H",
            f"X-GitHub-Api-Version: {API_VERSION}",
        ]
        if allow_escape_sequences:
            arguments.append("--allow-escape-sequences")
        arguments.append(endpoint)
        result = self._runner(
            arguments,
            env=environment,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode != 0:
            raise CollectorError("a required GitHub API request failed")
        return result.stdout

    def get_json(self, endpoint: str) -> tuple[bytes, Any]:
        body = self.get_bytes(endpoint)
        try:
            return body, json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CollectorError("GitHub returned invalid JSON for required evidence") from error


@dataclass
class ManifestEntry:
    path: str
    logical_type: str
    endpoint: str | None
    media_type: str
    byte_length: int
    sha256: str
    captured_at: str
    completeness: str = "complete"


class RawBundle:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.entries: list[ManifestEntry] = []

    def create(self) -> None:
        self.root.mkdir(mode=0o700, parents=True)
        os.chmod(self.root, 0o700)

    def write(
        self,
        relative_path: str,
        body: bytes,
        *,
        logical_type: str,
        endpoint: str | None = None,
        media_type: str = "application/octet-stream",
        completeness: str = "complete",
    ) -> None:
        destination = (self.root / relative_path).resolve(strict=False)
        if not destination.is_relative_to(self.root):
            raise CollectorError("refusing a raw bundle path outside its root")
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(destination.parent, 0o700)
        if destination.exists():
            raise CollectorError("refusing to overwrite raw evidence")
        destination.write_bytes(body)
        os.chmod(destination, 0o600)
        self.entries.append(
            ManifestEntry(
                path=relative_path,
                logical_type=logical_type,
                endpoint=endpoint,
                media_type=media_type,
                byte_length=len(body),
                sha256=hashlib.sha256(body).hexdigest(),
                captured_at=utc_now(),
                completeness=completeness,
            )
        )

    def write_json(
        self,
        relative_path: str,
        value: Any,
        *,
        logical_type: str,
        endpoint: str | None = None,
        completeness: str = "complete",
    ) -> None:
        body = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
        self.write(
            relative_path,
            body,
            logical_type=logical_type,
            endpoint=endpoint,
            media_type="application/json",
            completeness=completeness,
        )

    def seal(self, *, status: str, error_code: str | None = None) -> None:
        manifest = {
            "schema_version": 1,
            "collector_version": COLLECTOR_VERSION,
            "capture_status": status,
            "error_code": error_code,
            "files": [entry.__dict__ for entry in self.entries],
        }
        body = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
        manifest_path = self.root / "manifest.json"
        manifest_path.write_bytes(body)
        os.chmod(manifest_path, 0o600)
        digest_path = self.root / "manifest.sha256"
        digest_path.write_text(hashlib.sha256(body).hexdigest() + "  manifest.json\n")
        os.chmod(digest_path, 0o600)


def _paged_endpoint(endpoint: str, page: int = 1) -> str:
    separator = "&" if "?" in endpoint else "?"
    return f"{endpoint}{separator}per_page={PAGE_SIZE}&page={page}"


def _require_complete_object_page(value: Any, list_key: str) -> None:
    if not isinstance(value, dict) or not isinstance(value.get(list_key), list):
        raise CollectorError("GitHub returned an unexpected paginated object")
    total = value.get("total_count")
    if not isinstance(total, int) or total != len(value[list_key]):
        raise CollectorError("PR #60 evidence exceeded the fixed collector page size")


def _require_complete_array_page(value: Any) -> None:
    if not isinstance(value, list):
        raise CollectorError("GitHub returned an unexpected paginated array")
    if len(value) == PAGE_SIZE:
        raise CollectorError("PR #60 evidence reached the fixed collector page limit")


def _validate_identity(repository: Any, pull: Any, run: Any, jobs: Any) -> None:
    expected_repository = f"{OWNER}/{REPOSITORY}"
    if repository.get("full_name") != expected_repository:
        raise CollectorError("repository identity mismatch")
    if pull.get("number") != PULL_REQUEST:
        raise CollectorError("pull request identity mismatch")
    if pull.get("base", {}).get("sha") != BASE_SHA or pull.get("head", {}).get("sha") != HEAD_SHA:
        raise CollectorError("pull request SHA mismatch")
    if run.get("id") != RUN_ID or run.get("run_attempt") != RUN_ATTEMPT:
        raise CollectorError("workflow run attempt mismatch")
    if run.get("head_sha") != HEAD_SHA or run.get("event") != "pull_request":
        raise CollectorError("workflow run head identity mismatch")
    _require_complete_object_page(jobs, "jobs")
    jobs_by_id = {job.get("id"): job for job in jobs["jobs"]}
    for job_id, (expected_name, _) in FAILED_JOBS.items():
        job = jobs_by_id.get(job_id)
        if job is None or job.get("name") != expected_name or job.get("conclusion") != "failure":
            raise CollectorError("failed job identity mismatch")
        expected_run_url = f"https://api.github.com/repos/{OWNER}/{REPOSITORY}/actions/runs/{RUN_ID}"
        if job.get("run_url") != expected_run_url:
            raise CollectorError("failed job is not attached to the frozen run")


def _validate_compare(compare: Any) -> None:
    if not isinstance(compare, dict) or compare.get("status") not in {"ahead", "diverged"}:
        raise CollectorError("base/head comparison has an unexpected status")
    if compare.get("base_commit", {}).get("sha") != BASE_SHA:
        raise CollectorError("base/head comparison base SHA mismatch")
    commits = compare.get("commits")
    if not isinstance(commits, list) or not commits or commits[-1].get("sha") != HEAD_SHA:
        raise CollectorError("base/head comparison head SHA mismatch")


def _contents_endpoint(path: str, sha: str) -> str:
    return f"repos/{OWNER}/{REPOSITORY}/contents/{quote(path, safe='/')}?ref={sha}"


def _decode_content(response: Any) -> bytes:
    import base64

    if response.get("type") != "file" or response.get("encoding") != "base64":
        raise CollectorError("GitHub contents response is not a base64 file")
    try:
        encoded = response["content"]
        if not isinstance(encoded, str):
            raise ValueError("content is not text")
        return base64.b64decode("".join(encoded.split()), validate=True)
    except (KeyError, ValueError) as error:
        raise CollectorError("GitHub contents response could not be decoded") from error


def _should_fetch_source(sha_role: str, source_path: str, pull_files: list[Any]) -> bool:
    change = next(
        (item for item in pull_files if item.get("filename") == source_path),
        None,
    )
    if change is None:
        return True
    if sha_role == "base" and change.get("status") == "added":
        return False
    if sha_role == "head" and change.get("status") == "removed":
        return False
    return True


def capture_pr60(output: Path, repository_root: Path) -> Path:
    destination = validate_output_directory(output, repository_root)
    token = load_keychain_token()
    client = GitHubClient(token)

    repository_endpoint = f"repos/{OWNER}/{REPOSITORY}"
    pull_endpoint = f"repos/{OWNER}/{REPOSITORY}/pulls/{PULL_REQUEST}"
    run_endpoint = (
        f"repos/{OWNER}/{REPOSITORY}/actions/runs/{RUN_ID}/attempts/{RUN_ATTEMPT}"
    )
    jobs_endpoint = _paged_endpoint(f"{run_endpoint}/jobs")

    repository_body, repository = client.get_json(repository_endpoint)
    pull_body, pull = client.get_json(pull_endpoint)
    run_body, run = client.get_json(run_endpoint)
    jobs_body, jobs = client.get_json(jobs_endpoint)
    _validate_identity(repository, pull, run, jobs)

    bundle = RawBundle(destination)
    bundle.create()
    capture_started_at = utc_now()
    marker = b"Authenticated raw evidence. Do not commit or open in a browser.\n"
    bundle.write(
        "BAR_RAW_EVIDENCE_DO_NOT_COMMIT",
        marker,
        logical_type="safety_marker",
        media_type="text/plain",
    )
    capture_record = {
        "schema_version": 1,
        "collector_version": COLLECTOR_VERSION,
        "capture_started_at": capture_started_at,
        "github_api_version": API_VERSION,
        "repository": {
            "owner": OWNER,
            "name": REPOSITORY,
            "visibility": repository.get("visibility"),
        },
        "pull_request": PULL_REQUEST,
        "workflow_run_id": RUN_ID,
        "run_attempt": RUN_ATTEMPT,
        "workflow_id": run.get("workflow_id"),
        "workflow_path": run.get("path"),
        "event": run.get("event"),
        "base_ref": pull.get("base", {}).get("ref"),
        "head_ref": pull.get("head", {}).get("ref"),
        "base_sha": BASE_SHA,
        "head_sha": HEAD_SHA,
        "check_suite_id": run.get("check_suite_id"),
        "failed_job_ids": sorted(FAILED_JOBS),
    }
    bundle.write_json("capture.json", capture_record, logical_type="capture_identity")

    try:
        for path, body, logical_type, endpoint in (
            ("github/repository.json", repository_body, "repository", repository_endpoint),
            ("github/pull-request.json", pull_body, "pull_request", pull_endpoint),
            ("github/run-attempt.json", run_body, "run_attempt", run_endpoint),
            ("github/jobs.json", jobs_body, "jobs", jobs_endpoint),
        ):
            bundle.write(
                path,
                body,
                logical_type=logical_type,
                endpoint=endpoint,
                media_type="application/json",
            )

        commits_endpoint = _paged_endpoint(f"{pull_endpoint}/commits")
        commits_body, commits = client.get_json(commits_endpoint)
        _require_complete_array_page(commits)
        bundle.write(
            "github/pull-commits.json",
            commits_body,
            logical_type="pull_commits",
            endpoint=commits_endpoint,
            media_type="application/json",
        )

        files_endpoint = _paged_endpoint(f"{pull_endpoint}/files")
        files_body, files = client.get_json(files_endpoint)
        _require_complete_array_page(files)
        bundle.write(
            "github/pull-files.json",
            files_body,
            logical_type="pull_files",
            endpoint=files_endpoint,
            media_type="application/json",
        )

        compare_endpoint = f"repos/{OWNER}/{REPOSITORY}/compare/{BASE_SHA}...{HEAD_SHA}"
        compare_body, compare = client.get_json(compare_endpoint)
        _validate_compare(compare)
        bundle.write(
            "github/compare.json",
            compare_body,
            logical_type="base_head_compare",
            endpoint=compare_endpoint,
            media_type="application/json",
        )

        checks_endpoint = _paged_endpoint(
            f"repos/{OWNER}/{REPOSITORY}/commits/{HEAD_SHA}/check-runs"
        )
        checks_body, checks = client.get_json(checks_endpoint)
        _require_complete_object_page(checks, "check_runs")
        bundle.write(
            "github/checks/check-runs.json",
            checks_body,
            logical_type="check_runs",
            endpoint=checks_endpoint,
            media_type="application/json",
        )

        for job_id, (job_name, log_name) in FAILED_JOBS.items():
            annotations_endpoint = _paged_endpoint(
                f"repos/{OWNER}/{REPOSITORY}/check-runs/{job_id}/annotations"
            )
            annotations_body, annotations = client.get_json(annotations_endpoint)
            _require_complete_array_page(annotations)
            bundle.write(
                f"github/checks/{job_name}-annotations.json",
                annotations_body,
                logical_type="check_annotations",
                endpoint=annotations_endpoint,
                media_type="application/json",
            )
            log_endpoint = f"repos/{OWNER}/{REPOSITORY}/actions/jobs/{job_id}/logs"
            log_body = client.get_bytes(log_endpoint, allow_escape_sequences=True)
            if not log_body:
                raise CollectorError("a required failed-job log was empty")
            bundle.write(
                f"github/logs/{log_name}",
                log_body,
                logical_type="job_log",
                endpoint=log_endpoint,
                media_type="text/plain",
            )

        artifacts_endpoint = _paged_endpoint(
            f"repos/{OWNER}/{REPOSITORY}/actions/runs/{RUN_ID}/artifacts"
        )
        artifacts_body, artifacts = client.get_json(artifacts_endpoint)
        _require_complete_object_page(artifacts, "artifacts")
        bundle.write(
            "github/artifacts.json",
            artifacts_body,
            logical_type="artifact_inventory",
            endpoint=artifacts_endpoint,
            media_type="application/json",
            completeness="not_applicable" if not artifacts["artifacts"] else "complete",
        )

        content_index: list[dict[str, str]] = []
        for sha_role, sha in (("base", BASE_SHA), ("head", HEAD_SHA)):
            for source_path, rationale in SOURCE_SEEDS.items():
                endpoint = _contents_endpoint(source_path, sha)
                if not _should_fetch_source(sha_role, source_path, files):
                    bundle.write_json(
                        f"github/contents/missing/{sha_role}/{quote(source_path, safe='')}.json",
                        {
                            "sha_role": sha_role,
                            "sha": sha,
                            "path": source_path,
                            "reason": "file does not exist at this side of the pull request",
                        },
                        logical_type="repository_file_absent",
                        endpoint=endpoint,
                        completeness="not_available",
                    )
                    content_index.append(
                        {
                            "sha_role": sha_role,
                            "sha": sha,
                            "path": source_path,
                            "rationale": rationale,
                            "availability": "not_available",
                        }
                    )
                    continue
                response_body, response = client.get_json(endpoint)
                decoded = _decode_content(response)
                encoded_path = quote(source_path, safe="")
                bundle.write(
                    f"github/contents/api/{sha_role}/{encoded_path}.json",
                    response_body,
                    logical_type="contents_api_response",
                    endpoint=endpoint,
                    media_type="application/json",
                )
                bundle.write(
                    f"github/contents/{sha_role}/{source_path}",
                    decoded,
                    logical_type="repository_file",
                    endpoint=endpoint,
                    media_type="text/plain",
                )
                content_index.append(
                    {
                        "sha_role": sha_role,
                        "sha": sha,
                        "path": source_path,
                        "rationale": rationale,
                        "availability": "complete",
                    }
                )
        bundle.write_json(
            "github/contents/index.json",
            content_index,
            logical_type="source_selection",
        )
    except Exception:
        bundle.seal(status="incomplete", error_code="required_evidence_failed")
        raise

    bundle.seal(status="complete")
    return destination
