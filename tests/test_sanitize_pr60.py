import tempfile
import subprocess
import unittest
from pathlib import Path

from bar_tools.sanitize_pr60 import (
    CandidateBoundaryError,
    SanitizationError,
    _job_summary,
    _write_private_file,
    sanitize_text,
    run_gitleaks,
    validate_candidate_directory,
    verify_safe_text,
)


class SanitizerCanaryTests(unittest.TestCase):
    def test_removes_sensitive_canaries_and_preserves_diagnostic_context(self) -> None:
        source = """Build link-mcp with Python 3.12
/home/runner/work/link/link/mcp_package/.linkignore
C:\\Users\\alice\\AppData\\Local\\Temp\\build\\.linkignore
developer@example.com
github_pat_11AA_TEST_SECRET_VALUE
eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturevalue
https://alice:password@example.test/archive?token=secret
UNAPPROVED_SECRET=hidden-value
-----BEGIN PRIVATE KEY-----
private-material
-----END PRIVATE KEY-----
"""

        sanitized, counts, _ = sanitize_text(source)

        for secret in (
            "alice",
            "developer@example.com",
            "github_pat_11AA_TEST_SECRET_VALUE",
            "eyJhbGciOiJIUzI1NiJ9",
            "password",
            "hidden-value",
            "private-material",
        ):
            self.assertNotIn(secret, sanitized)
        self.assertIn("<WORKSPACE>/mcp_package/.linkignore", sanitized)
        self.assertIn("<HOME>\\AppData\\Local\\Temp\\build\\.linkignore", sanitized)
        self.assertIn("Build link-mcp", sanitized)
        self.assertIn("Python 3.12", sanitized)
        self.assertGreater(counts["credential"], 0)
        self.assertGreater(counts["path"], 0)
        self.assertGreater(counts["email"], 0)
        self.assertGreater(counts["environment"], 0)

    def test_preserves_public_urls_python_paths_and_test_names(self) -> None:
        source = """<TEMP>/lib/python3.12/site-packages/pyproject_hooks/_in_process/_in_process.py
test_prompt_injection_refusal_is_recorded
ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION
https://github.com/actions/checkout/issues/1809
C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\build\\\\.linkignore
"""

        sanitized, _, _ = sanitize_text(source)

        self.assertIn("pyproject_hooks/_in_process/_in_process.py", sanitized)
        self.assertIn("test_prompt_injection_refusal_is_recorded", sanitized)
        self.assertIn("ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION", sanitized)
        self.assertIn("https://github.com/actions/checkout/issues/1809", sanitized)
        self.assertIn("<HOME>", sanitized)
        self.assertNotIn("RUNNER~1", sanitized)

    def test_verifier_rejects_a_surviving_github_token(self) -> None:
        with self.assertRaises(SanitizationError):
            verify_safe_text("accidental github_pat_11AA_SURVIVOR")


class CandidateBoundaryTests(unittest.TestCase):
    def test_rejects_candidate_inside_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository = Path(temporary_directory) / "bar"
            repository.mkdir()

            with self.assertRaises(CandidateBoundaryError):
                validate_candidate_directory(repository / "candidate", repository)

    def test_rejects_existing_candidate_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            repository = root / "bar"
            candidate = root / "candidate"
            repository.mkdir()
            candidate.mkdir()

            with self.assertRaises(CandidateBoundaryError):
                validate_candidate_directory(candidate, repository)

    def test_nested_candidate_directories_are_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "candidate"
            root.mkdir(mode=0o700)

            _write_private_file(root / "public" / "fixture" / "evidence.json", b"[]\n")

            self.assertEqual((root / "public").stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / "public" / "fixture").stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / "public" / "fixture" / "evidence.json").stat().st_mode & 0o777, 0o600)


class IndependentScannerTests(unittest.TestCase):
    def test_gitleaks_scan_uses_full_redaction(self) -> None:
        calls: list[list[str]] = []

        def runner(arguments: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
            calls.append(arguments)
            output = b"8.30.1\n" if arguments[1] == "version" else b""
            return subprocess.CompletedProcess(arguments, 0, output, b"")

        version = run_gitleaks(Path("/safe/candidate"), runner=runner)

        self.assertEqual(version, "8.30.1")
        self.assertIn("--redact=100", calls[1])
        self.assertIn("--no-banner", calls[1])
        self.assertNotIn("--verbose", calls[1])


class FixtureMinimizationTests(unittest.TestCase):
    def test_only_focused_job_keeps_step_names(self) -> None:
        jobs = {
            "jobs": [
                {"id": 1, "name": "passing", "conclusion": "success", "steps": [{"name": "noise", "conclusion": "success"}]},
                {"id": 2, "name": "focused", "conclusion": "failure", "steps": [{"name": "failure", "conclusion": "failure"}]},
            ]
        }

        summary = _job_summary(jobs, focused_job_id=2)

        self.assertEqual(summary[0]["steps"], [])
        self.assertEqual(summary[1]["steps"], [{"name": "failure", "conclusion": "failure"}])


if __name__ == "__main__":
    unittest.main()
