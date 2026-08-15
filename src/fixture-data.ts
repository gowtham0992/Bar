import packageEvidenceJson from "../fixtures/public/link-pr-60-package-v1/evidence.json";
import packageFixtureJson from "../fixtures/public/link-pr-60-package-v1/fixture.json";
import packageRegressionEvidenceJson from "../fixtures/public/link-pr-60-package-regression-v1/evidence.json";
import packageRegressionFixtureJson from "../fixtures/public/link-pr-60-package-regression-v1/fixture.json";
import windowsEvidenceJson from "../fixtures/public/link-pr-60-windows-smoke-v1/evidence.json";
import windowsFixtureJson from "../fixtures/public/link-pr-60-windows-smoke-v1/fixture.json";

export const APPROVED_FIXTURE_IDS = [
  "link-pr-60-package-v1",
  "link-pr-60-package-regression-v1",
  "link-pr-60-windows-smoke-v1",
] as const;

export type FixtureId = (typeof APPROVED_FIXTURE_IDS)[number];
export type MemoryKey =
  | "python-package-sdist-missing-forced-include"
  | "windows-sqlite-file-lock";

export type EvidenceItem = {
  id: string;
  kind: string;
  title: string;
  content: string;
  sequence: number;
  source: {
    job: string | null;
    step: string | null;
    path: string | null;
    sha_role: string | null;
    original_line_start: number;
    original_line_end: number;
  };
};

export type Fixture = {
  fixture_id: FixtureId;
  focus: { job: string; failed_step: string };
  memory_key: MemoryKey;
  scenario: {
    kind: "captured" | "synthetic_replay";
    based_on_fixture_id: FixtureId | null;
  };
  source: { repository: string; pull_request: number; public_url: string };
  run: { event: string; attempt: number; base_sha: string; head_sha: string };
  evidence_ids: string[];
  missing_evidence: string[];
};

export type FixtureBundle = {
  fixture: Fixture;
  evidence: EvidenceItem[];
};

const fixtures: Record<FixtureId, FixtureBundle> = {
  "link-pr-60-package-v1": {
    fixture: packageFixtureJson as Fixture,
    evidence: packageEvidenceJson as EvidenceItem[],
  },
  "link-pr-60-package-regression-v1": {
    fixture: packageRegressionFixtureJson as Fixture,
    evidence: packageRegressionEvidenceJson as EvidenceItem[],
  },
  "link-pr-60-windows-smoke-v1": {
    fixture: windowsFixtureJson as Fixture,
    evidence: windowsEvidenceJson as EvidenceItem[],
  },
};

export function isFixtureId(value: unknown): value is FixtureId {
  return (
    typeof value === "string" &&
    (APPROVED_FIXTURE_IDS as readonly string[]).includes(value)
  );
}

export function getFixture(fixtureId: FixtureId): FixtureBundle {
  return fixtures[fixtureId];
}

export function getMemoryKey(fixtureId: FixtureId): MemoryKey {
  return fixtures[fixtureId].fixture.memory_key;
}

export function getInvestigationEvidence(
  fixtureId: FixtureId,
  evidenceIds: readonly string[],
): EvidenceItem[] {
  const included = new Set(evidenceIds);
  return fixtures[fixtureId].evidence
    .filter((item) => included.has(item.id))
    .sort((left, right) => left.sequence - right.sequence);
}

export function listFixtures(): Array<{
  fixtureId: FixtureId;
  job: string;
  failedStep: string;
  repository: string;
  pullRequest: number;
  evidenceCount: number;
  hasKnownGap: boolean;
  scenarioKind: Fixture["scenario"]["kind"];
}> {
  return APPROVED_FIXTURE_IDS.map((fixtureId) => {
    const fixture = fixtures[fixtureId].fixture;
    return {
      fixtureId,
      job: fixture.focus.job,
      failedStep: fixture.focus.failed_step,
      repository: fixture.source.repository,
      pullRequest: fixture.source.pull_request,
      evidenceCount: fixture.evidence_ids.length,
      hasKnownGap: fixture.missing_evidence.length > 0,
      scenarioKind: fixture.scenario.kind,
    };
  });
}
