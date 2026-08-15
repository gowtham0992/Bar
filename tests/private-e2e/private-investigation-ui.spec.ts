import { expect, test, type Page } from "@playwright/test";

const INVESTIGATION_ID = "a".repeat(64);
const PAGE_PATH = `/private/investigations/${INVESTIGATION_ID}`;
const evidence = [
  {
    id: "E-PKG-001",
    kind: "job_log",
    title: "Failure window from package job",
    content: "OSError: Forced include not found: .linkignore",
    sequence: 1,
    source: {
      job: "package",
      step: "Build link-mcp",
      path: null,
      sha_role: null,
      original_line_start: 271,
      original_line_end: 292,
    },
  },
  {
    id: "E-PKG-002",
    kind: "source_diff",
    title: "Packaging configuration change",
    content: '"../.linkignore" = ".linkignore"',
    sequence: 2,
    source: {
      job: null,
      step: null,
      path: "mcp_package/pyproject.toml",
      sha_role: "base_to_head",
      original_line_start: 24,
      original_line_end: 41,
    },
  },
];

function investigation() {
  return {
    id: INVESTIGATION_ID,
    repository: "gowtham0992/link",
    status: "complete",
    workflowInstanceId: `private-${INVESTIGATION_ID}`,
    workflowLaunchState: "started",
    milestones: [
      { stage: "load_evidence", status: "complete" },
      { stage: "recall_memory", status: "complete" },
      { stage: "diagnose", status: "complete" },
    ],
    source: {
      workflow: { id: 99, name: "CI", path: ".github/workflows/ci.yml" },
      run: {
        id: 600060001,
        attempt: 1,
        event: "pull_request",
        head_sha: "b".repeat(40),
        html_url: "https://github.com/gowtham0992/link/actions/runs/600060001",
      },
      pullRequest: { number: 60, base_sha: "c".repeat(40), head_sha: "b".repeat(40) },
      focus: { job_id: 600060002, job_name: "package", failed_step: "Build link-mcp" },
      missingEvidence: [],
    },
    diagnosis: {
      outcome: "diagnosed",
      summary: "The package build cannot find .linkignore.",
      explanation: "The forced include references a file absent from the build context.",
      confidence: 0.91,
      evidenceIds: ["E-PKG-001", "E-PKG-002"],
      uncertainty: "The repair has not been executed.",
      proposedResolution: "Include .linkignore in the source distribution.",
      memoryAssessment: "not_available",
      memoryExplanation: "No reviewed memory was supplied.",
    },
    memoryMatch: null,
    modelCalls: 1,
    modelUsage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
    followUpCalls: 0,
    followUpLimit: 3,
    followUps: [] as Array<Record<string, unknown>>,
    review: null as Record<string, unknown> | null,
    evidence,
    error: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

async function mockPrivateApi(page: Page, options: { queuedOnce?: boolean } = {}) {
  const state = investigation();
  const requests = { reads: 0, followUps: 0, reviews: [] as unknown[] };
  await page.route(`**/api/v1/private/investigations/${INVESTIGATION_ID}`, (route) => {
    requests.reads += 1;
    if (options.queuedOnce && requests.reads === 1) {
      return route.fulfill({
        json: {
          investigation: {
            ...state,
            status: "queued",
            diagnosis: null,
            modelCalls: 0,
            modelUsage: null,
            milestones: state.milestones.map((item) => ({ ...item, status: "pending" })),
          },
        },
      });
    }
    return route.fulfill({ json: { investigation: state } });
  });
  await page.route(
    `**/api/v1/private/investigations/${INVESTIGATION_ID}/follow-ups`,
    async (route) => {
      requests.followUps += 1;
      expect(route.request().headers()["idempotency-key"]).toMatch(/^[a-f0-9]{32}$/);
      expect(route.request().postDataJSON()).toEqual({
        question: "What evidence supports this?",
      });
      const followUp = {
        id: "f".repeat(64),
        question: "What evidence supports this?",
        status: "complete",
        answer: "The job log and packaging diff establish the missing file relationship.",
        evidenceIds: ["E-PKG-001", "E-PKG-002"],
        modelUsage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        createdAt: 3,
        updatedAt: 4,
      };
      state.followUps = [followUp];
      state.followUpCalls = 1;
      await route.fulfill({ status: 201, json: { followUp, remainingCalls: 2 } });
    },
  );
  await page.route(
    `**/api/v1/private/investigations/${INVESTIGATION_ID}/review`,
    async (route) => {
      const input = route.request().postDataJSON();
      requests.reviews.push(input);
      expect(route.request().headers()["idempotency-key"]).toMatch(/^[a-f0-9]{32}$/);
      state.review = {
        id: "r".repeat(64),
        action: input.action,
        resolution:
          input.action === "reject"
            ? null
            : input.resolution ?? state.diagnosis.proposedResolution,
        memorySaved: input.action !== "reject",
        createdAt: 5,
      };
      await route.fulfill({ status: 201, json: { review: state.review } });
    },
  );
  return requests;
}

async function openReadyInvestigation(page: Page) {
  await page.goto(PAGE_PATH);
  await expect(page.locator("#diagnosis-title")).toHaveText(
    "The package build cannot find .linkignore.",
  );
  await expect(page.getByText("Cloudflare Access protected")).toBeVisible();
  await expect(page.getByText("1 of 1 diagnosis call used")).toBeVisible();
  await expect(page.getByText("0 of 3 follow-up calls used")).toBeVisible();
  await expect(page.getByText("The repair has not been executed.")).toBeVisible();
  await expect(page.getByRole("link", { name: "E-PKG-001" }).first()).toHaveAttribute(
    "href",
    "#evidence-1",
  );
  await expect(page.locator("#evidence-1")).toContainText("Forced include not found");
}

test("shows the private investigation and closes cited chat after approval", async ({
  page,
}, testInfo) => {
  const requests = await mockPrivateApi(page, { queuedOnce: true });
  await openReadyInvestigation(page);

  await page.getByLabel("Question about this evidence").fill("What evidence supports this?");
  await page.getByRole("button", { name: "Ask follow-up" }).click();
  await expect(page.getByText("The job log and packaging diff establish")).toBeVisible();
  await expect(page.getByText("1 of 3 follow-up calls used")).toBeVisible();
  await expect(page.locator("#follow-up-history").getByRole("link", { name: "E-PKG-002" })).toHaveAttribute(
    "href",
    "#evidence-2",
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Resolution approved")).toBeVisible();
  await expect(page.getByText("reusable memory for this repository")).toBeVisible();
  await expect(page.getByText("Follow-up chat is closed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask follow-up" })).toBeHidden();
  expect(requests.followUps).toBe(1);
  expect(requests.reads).toBeGreaterThanOrEqual(2);
  expect(requests.reviews).toEqual([{ action: "approve" }]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("private-approved.png"), fullPage: true });
});

test("corrects and approves a private resolution", async ({ page }) => {
  const requests = await mockPrivateApi(page);
  await openReadyInvestigation(page);
  await page.getByRole("button", { name: "Correct and approve" }).click();
  const correction = "Add .linkignore to the sdist manifest, then rebuild the wheel.";
  await page.getByLabel("Corrected resolution").fill(correction);
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("Resolution approved")).toBeVisible();
  expect(requests.reviews).toEqual([{ action: "correct_and_approve", resolution: correction }]);
});

test("rejects without creating reusable memory", async ({ page }) => {
  const requests = await mockPrivateApi(page);
  await openReadyInvestigation(page);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Diagnosis rejected")).toBeVisible();
  await expect(page.getByText("was not saved to memory")).toBeVisible();
  await expect(page.getByText("Follow-up chat is closed")).toBeVisible();
  expect(requests.reviews).toEqual([{ action: "reject" }]);
});
