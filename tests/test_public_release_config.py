from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PublicReleaseConfigTests(unittest.TestCase):
    def test_public_demo_disables_versioned_preview_urls(self) -> None:
        public_config = (ROOT / "wrangler.jsonc").read_text(encoding="utf-8")

        self.assertIn('"preview_urls": false', public_config)

    def test_private_example_contains_only_placeholder_account_values(self) -> None:
        example = (ROOT / "wrangler.private.example.jsonc").read_text(encoding="utf-8")

        self.assertIn('"pattern": "bar-private.example.com"', example)
        self.assertIn(
            '"ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com"',
            example,
        )
        self.assertIn(
            '"ACCESS_AUDIENCE": "REPLACE_WITH_INGESTION_ACCESS_AUDIENCE"',
            example,
        )
        self.assertIn(
            '"ACCESS_SUMMARY_AUDIENCE": "REPLACE_WITH_SUMMARY_ACCESS_AUDIENCE"',
            example,
        )
        self.assertIn('"workers_dev": false', example)
        self.assertIn('"preview_urls": false', example)

    def test_populated_private_wrangler_file_is_ignored(self) -> None:
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("wrangler.private.jsonc", ignored)

    def test_private_e2e_uses_tracked_placeholder_config(self) -> None:
        playwright_config = (ROOT / "playwright.private.config.ts").read_text(
            encoding="utf-8"
        )

        self.assertIn("--config wrangler.private.example.jsonc", playwright_config)
        self.assertNotIn("--config wrangler.private.jsonc", playwright_config)


if __name__ == "__main__":
    unittest.main()
