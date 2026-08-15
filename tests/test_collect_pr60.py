import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bar_tools.collect_pr60 import (
    BASE_SHA,
    HEAD_SHA,
    SOURCE_SEEDS,
    GitHubClient,
    OutputBoundaryError,
    _decode_content,
    _should_fetch_source,
    _validate_compare,
    validate_output_directory,
)


class OutputBoundaryTests(unittest.TestCase):
    def test_rejects_output_inside_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository = Path(temporary_directory) / "bar"
            repository.mkdir()

            with self.assertRaises(OutputBoundaryError):
                validate_output_directory(repository / "raw", repository)

    def test_rejects_existing_output_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            repository = root / "bar"
            output = root / "raw"
            repository.mkdir()
            output.mkdir()

            with self.assertRaises(OutputBoundaryError):
                validate_output_directory(output, repository)


class GitHubClientTests(unittest.TestCase):
    def test_token_is_passed_only_in_child_environment(self) -> None:
        calls: list[tuple[list[str], dict[str, str]]] = []

        def runner(
            arguments: list[str],
            *,
            env: dict[str, str],
            check: bool,
            stdout: int,
            stderr: int,
        ) -> subprocess.CompletedProcess[bytes]:
            calls.append((arguments, env))
            return subprocess.CompletedProcess(arguments, 0, b"{}", b"")

        token = "github_pat_TEST_ONLY_DO_NOT_USE"
        client = GitHubClient(token, runner=runner)
        client.get_bytes("repos/gowtham0992/link/pulls/60")

        arguments, environment = calls[0]
        self.assertNotIn(token, " ".join(arguments))
        self.assertEqual(environment["GH_TOKEN"], token)
        self.assertNotIn("GH_TOKEN", os.environ)
        self.assertIn("X-GitHub-Api-Version: 2026-03-10", arguments)

    def test_log_capture_explicitly_allows_escaped_bytes(self) -> None:
        calls: list[list[str]] = []

        def runner(arguments: list[str], **_: object) -> subprocess.CompletedProcess[bytes]:
            calls.append(arguments)
            return subprocess.CompletedProcess(arguments, 0, b"log", b"")

        client = GitHubClient("github_pat_TEST_ONLY_DO_NOT_USE", runner=runner)
        client.get_bytes(
            "repos/gowtham0992/link/actions/jobs/94347441040/logs",
            allow_escape_sequences=True,
        )

        self.assertIn("--allow-escape-sequences", calls[0])


class CompareValidationTests(unittest.TestCase):
    def test_accepts_diverged_pr_when_frozen_shas_match(self) -> None:
        _validate_compare(
            {
                "status": "diverged",
                "base_commit": {"sha": BASE_SHA},
                "commits": [{"sha": HEAD_SHA}],
            }
        )


class ContentsDecodingTests(unittest.TestCase):
    def test_decodes_github_base64_with_line_wrapping(self) -> None:
        decoded = _decode_content(
            {
                "type": "file",
                "encoding": "base64",
                "content": "aGVsbG8g\nd29ybGQ=\n",
            }
        )

        self.assertEqual(decoded, b"hello world")

    def test_includes_windows_traceback_referenced_source_files(self) -> None:
        for path in (
            "scripts/eval_token_economics.py",
            "tests/test_guard_core.py",
            "tests/test_token_economics.py",
        ):
            self.assertIn(path, SOURCE_SEEDS)

    def test_skips_base_fetch_for_file_added_by_pull_request(self) -> None:
        pull_files = [{"filename": "tests/test_guard_core.py", "status": "added"}]

        self.assertFalse(_should_fetch_source("base", "tests/test_guard_core.py", pull_files))
        self.assertTrue(_should_fetch_source("head", "tests/test_guard_core.py", pull_files))


class CommandLineTests(unittest.TestCase):
    def test_direct_script_invocation_loads_local_collector(self) -> None:
        repository = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [
                sys.executable,
                str(repository / "scripts" / "collect_pr60.py"),
                "--output",
                str(repository / "raw-evidence-test"),
            ],
            cwd=repository,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("raw output must be outside", result.stderr)
        self.assertNotIn("ModuleNotFoundError", result.stderr)


if __name__ == "__main__":
    unittest.main()
