import { expect, test, type Page, type Route } from "@playwright/test";

const SESSION_ID = "a".repeat(64);
const fixtures = [
  {
    fixtureId: "link-pr-60-package-regression-v1",
    job: "package-regression",
    failedStep: "Build wheel from source distribution",
    repository: "gowtham0992/link",
    pullRequest: 60,
    evidenceCount: 4,
    hasKnownGap: false,
    scenarioKind: "synthetic_replay",
  },
  {
    fixtureId: "link-pr-60-package-v1",
    job: "package",
    failedStep: "Build link-mcp",
    repository: "gowtham0992/link",
    pullRequest: 60,
    evidenceCount: 4,
    hasKnownGap: false,
    scenarioKind: "captured",
  },
  {
    fixtureId: "link-pr-60-windows-smoke-v1",
    job: "windows-smoke",
    failedStep: "Run broad Windows tests",
    repository: "gowtham0992/link",
    pullRequest: 60,
    evidenceCount: 5,
    hasKnownGap: true,
    scenarioKind: "captured",
  },
];

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

const regressionEvidence = [
  {
    ...evidence[0],
    id: "E-PKG-R2-001",
    title: "Separate regression build failure",
    content: "FileNotFoundError: Forced include not found: <TEMP>/.linkignore",
    source: {
      ...evidence[0].source,
      job: "package-regression",
      step: "Build wheel from source distribution",
    },
  },
  {
    ...evidence[1],
    id: "E-PKG-R2-002",
    kind: "artifact_listing",
    title: "Current source distribution contents",
    content: "No .linkignore entry is present in the source distribution listing.",
  },
];

function investigation(status: "queued" | "complete") {
  return {
    sessionId: SESSION_ID,
    status,
    fixtureId: "link-pr-60-package-v1",
    workflowInstanceId: null,
    evidenceIds: evidence.map((item) => item.id),
    milestones:
      status === "complete"
        ? [
            { stage: "load_evidence", status: "complete" },
            { stage: "recall_memory", status: "complete" },
            { stage: "diagnose", status: "complete" },
          ]
        : [
            { stage: "load_evidence", status: "pending" },
            { stage: "recall_memory", status: "pending" },
            { stage: "diagnose", status: "pending" },
          ],
    diagnosis:
      status === "complete"
        ? {
            outcome: "diagnosed",
            summary: "The package build cannot find .linkignore in the sdist context.",
            explanation:
              "The packaging configuration force-includes a path that is absent when the source distribution is built.",
            confidence: 0.9,
            evidenceIds: ["E-PKG-001", "E-PKG-002"],
            uncertainty: "The proposed source change has not been executed in this replay.",
            proposedResolution: "Include .linkignore in the sdist before building the wheel.",
            memoryAssessment: "not_available",
            memoryExplanation: "No reviewed memory was supplied.",
          }
        : null,
    modelCalls: status === "complete" ? 1 : 0,
    modelUsage: null,
    memoryMatch: null,
    canMutate: true,
    followUpCalls: 0,
    followUps: [],
    review: null,
    error: null,
    evidence,
  };
}

async function mockFixtureList(page: Page) {
  await page.route("**/api/fixtures", (route) =>
    route.fulfill({ json: { fixtures } }),
  );
}

async function assertNoPageErrors(
  page: Page,
  options: { allowFailedResource?: boolean } = {},
) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !(
        options.allowFailedResource &&
        message.text().startsWith("Failed to load resource:")
      )
    ) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return () => expect(errors).toEqual([]);
}

test("keeps start disabled until a fixture is selected", async ({ page }) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);

  await page.goto("/");
  await expect(page.getByText("Known evidence gap")).toBeVisible();

  const start = page.getByRole("button", { name: "Start investigation" });
  await expect(start).toBeDisabled();

  await page.locator('input[value="link-pr-60-package-v1"]').focus();
  await page.keyboard.press("Space");
  await expect(start).toBeEnabled();
  checkConsole();
});

test("runs a fixture, polls by investigation ID, and presents cited evidence", async ({
  page,
}, testInfo) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  let postCount = 0;
  let getCount = 0;

  await page.route("**/api/investigations", async (route: Route) => {
    expect(route.request().method()).toBe("POST");
    postCount += 1;
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[a-z0-9_-]{16,128}$/i);
    expect(route.request().postDataJSON()).toEqual({
      fixtureId: "link-pr-60-package-v1",
    });
    await route.fulfill({
      status: 202,
      json: {
        investigation: {
          sessionId: SESSION_ID,
          fixtureId: "link-pr-60-package-v1",
          status: "queued",
          workflowInstanceId: null,
        },
      },
    });
  });
  await page.route(`**/api/investigations/${SESSION_ID}`, async (route) => {
    getCount += 1;
    await route.fulfill({
      json: { investigation: investigation(getCount === 1 ? "queued" : "complete") },
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose a failed check" })).toBeVisible();
  await expect(page.getByText("Known evidence gap")).toBeVisible();

  const packageFixture = page.locator('input[value="link-pr-60-package-v1"]');
  await packageFixture.focus();
  await page.keyboard.press("Space");
  const start = page.getByRole("button", { name: "Start investigation" });
  await start.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Polling by investigation ID")).toBeVisible();
  await expect(page.locator("#investigation-id")).toHaveAttribute("title", SESSION_ID);
  await expect(page).toHaveURL(new RegExp(`investigation=${SESSION_ID}`));
  await expect(page.getByRole("heading", { name: /package build cannot find/i })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByText("What remains uncertain")).toBeVisible();
  await expect(page.getByText("90%")).toBeVisible();
  await expect(page.getByRole("link", { name: "E-PKG-001" })).toHaveAttribute(
    "href",
    "#evidence-1",
  );
  await expect(page.locator("#evidence-1")).toContainText("Forced include not found");
  await expect(page.getByText("Complete · 1 of 1 diagnosis call used")).toBeVisible();
  await expect(page.getByText("One diagnosis call maximum")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Follow up" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review resolution" })).toBeVisible();
  expect(postCount).toBe(1);
  expect(getCount).toBe(2);

  const progressBox = await page.locator(".progress-panel").boundingBox();
  const diagnosisBox = await page.locator(".diagnosis-panel").boundingBox();
  expect(progressBox).not.toBeNull();
  expect(diagnosisBox).not.toBeNull();
  if (testInfo.project.name === "mobile-chrome") {
    expect(diagnosisBox!.y).toBeGreaterThan(progressBox!.y + progressBox!.height);
  } else {
    expect(Math.abs(diagnosisBox!.y - progressBox!.y)).toBeLessThan(3);
    expect(diagnosisBox!.x).toBeGreaterThan(progressBox!.x);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: testInfo.outputPath("investigation-complete.png"),
    fullPage: true,
  });
  checkConsole();
});

test("shows reviewed-memory provenance while citing only the current failure", async ({
  page,
}) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  const state = {
    ...investigation("complete"),
    fixtureId: "link-pr-60-package-regression-v1",
    evidenceIds: regressionEvidence.map((item) => item.id),
    evidence: regressionEvidence,
    memoryMatch: {
      reviewId: "c".repeat(64),
      sourceInvestigationId: "b".repeat(64),
      sourceFixtureId: "link-pr-60-package-v1",
      action: "correct_and_approve",
      resolution: "Include .linkignore in the source distribution, then verify the wheel.",
      diagnosisSummary: "The package build omitted a forced include.",
      reviewedAt: 1_786_662_000_000,
    },
    diagnosis: {
      ...investigation("complete").diagnosis,
      summary: "The separate regression sdist still omits .linkignore.",
      evidenceIds: ["E-PKG-R2-001", "E-PKG-R2-002"],
      memoryAssessment: "applies",
      memoryExplanation:
        "The current failure and artifact listing independently support the same cause.",
    },
  };
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({ json: { investigation: state } }),
  );

  await page.goto(`/?investigation=${SESSION_ID}`);
  await expect(
    page.getByText("Synthetic similar replay", { exact: true }),
  ).toBeVisible();
  const memory = page.getByLabel("Reviewed memory match");
  await expect(memory.getByText("Previously approved investigation")).toBeVisible();
  await expect(memory.getByText(/link-pr-60-package-v1/)).toBeVisible();
  await expect(memory.getByText("applies", { exact: true })).toBeVisible();
  await expect(memory.getByText(/current failure and artifact listing/i)).toBeVisible();
  await expect(memory.getByText(/current evidence/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "E-PKG-R2-001" })).toHaveAttribute(
    "href",
    "#evidence-1",
  );
  await expect(page.getByRole("link", { name: "E-PKG-001" })).toHaveCount(0);
  await expect(page.getByText("Complete · 1 of 1 diagnosis call used")).toBeVisible();
  await expect(
    page.locator('input[value="link-pr-60-package-regression-v1"]'),
  ).toBeChecked();
  checkConsole();
});

test("asks one cited follow-up and corrects and approves the resolution", async ({
  page,
}, testInfo) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  let state = investigation("complete");
  let followUpPosts = 0;
  let reviewPosts = 0;

  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({ json: { investigation: state } }),
  );
  await page.route(`**/api/investigations/${SESSION_ID}/follow-ups`, async (route) => {
    followUpPosts += 1;
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[a-f0-9]{32}$/);
    expect(route.request().postDataJSON()).toEqual({
      question: "Why does the source distribution matter?",
    });
    const followUp = {
      id: "b".repeat(64),
      question: "Why does the source distribution matter?",
      status: "complete",
      answer: "The force-include is resolved while building the sdist, where .linkignore is absent.",
      evidenceIds: ["E-PKG-001", "E-PKG-002"],
      usage: { promptTokens: 90, completionTokens: 24, totalTokens: 114 },
      error: null,
    };
    state = { ...state, followUpCalls: 1, followUps: [followUp] };
    await route.fulfill({ status: 201, json: { followUp, remainingCalls: 2 } });
  });
  await page.route(`**/api/investigations/${SESSION_ID}/review`, async (route) => {
    reviewPosts += 1;
    expect(route.request().postDataJSON()).toEqual({
      action: "correct_and_approve",
      resolution: "Ship .linkignore in the sdist, then verify wheel creation from that sdist.",
    });
    const review = {
      reviewId: "c".repeat(64),
      sessionId: SESSION_ID,
      fixtureId: state.fixtureId,
      action: "correct_and_approve",
      resolution: "Ship .linkignore in the sdist, then verify wheel creation from that sdist.",
      diagnosisSummary: state.diagnosis.summary,
      evidenceIds: state.diagnosis.evidenceIds,
      createdAt: 1_786_662_000_000,
      memorySaved: true,
    };
    state = { ...state, review };
    await route.fulfill({ status: 201, json: { review } });
  });

  await page.goto(`/?investigation=${SESSION_ID}`);
  await page.getByLabel("Ask about this diagnosis or its evidence").fill(
    "Why does the source distribution matter?",
  );
  await page.evaluate(() => {
    const form = document.querySelector("#follow-up-form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(page.getByText("The force-include is resolved")).toBeVisible();
  await expect(page.getByText("2 of 3 follow-up calls remaining.")).toBeVisible();
  const citedFollowUp = page.locator(".follow-up-exchange").getByRole("link", {
    name: "E-PKG-002",
  });
  await expect(citedFollowUp).toHaveAttribute("href", "#evidence-2");
  expect(followUpPosts).toBe(1);

  await page.getByRole("button", { name: "Correct and approve" }).click();
  await page.getByLabel("Corrected resolution").fill(
    "Ship .linkignore in the sdist, then verify wheel creation from that sdist.",
  );
  await page.getByRole("button", { name: "Save correction and approve" }).click();
  await expect(page.getByText("Resolution approved")).toBeVisible();
  await expect(page.getByText("saved as reusable memory")).toBeVisible();
  await expect(page.getByText("Approved resolution", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Ship .linkignore in the sdist, then verify wheel creation from that sdist."),
  ).toBeVisible();
  await expect(page.getByLabel("Ask about this diagnosis or its evidence")).toBeDisabled();
  expect(reviewPosts).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("follow-up-reviewed.png"),
    fullPage: true,
  });
  checkConsole();
});

test("keeps a rejected diagnosis in history without saving memory", async ({ page }) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  const state = investigation("complete");
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({ json: { investigation: state } }),
  );
  await page.route(`**/api/investigations/${SESSION_ID}/review`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: "reject" });
    await route.fulfill({
      status: 201,
      json: {
        review: {
          reviewId: "d".repeat(64),
          sessionId: SESSION_ID,
          fixtureId: state.fixtureId,
          action: "reject",
          resolution: null,
          diagnosisSummary: state.diagnosis.summary,
          evidenceIds: state.diagnosis.evidenceIds,
          createdAt: 1_786_662_000_000,
          memorySaved: false,
        },
      },
    });
  });

  await page.goto(`/?investigation=${SESSION_ID}`);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Diagnosis rejected")).toBeVisible();
  await expect(page.getByText("not saved to memory")).toBeVisible();
  await expect(page.getByRole("heading", { name: /package build cannot find/i })).toBeVisible();
  checkConsole();
});

test("approves the proposed resolution without accepting client resolution text", async ({
  page,
}) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  const state = investigation("complete");
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({ json: { investigation: state } }),
  );
  await page.route(`**/api/investigations/${SESSION_ID}/review`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: "approve" });
    await route.fulfill({
      status: 201,
      json: {
        review: {
          reviewId: "e".repeat(64),
          sessionId: SESSION_ID,
          fixtureId: state.fixtureId,
          action: "approve",
          resolution: state.diagnosis.proposedResolution,
          diagnosisSummary: state.diagnosis.summary,
          evidenceIds: state.diagnosis.evidenceIds,
          createdAt: 1_786_662_000_000,
          memorySaved: true,
        },
      },
    });
  });

  await page.goto(`/?investigation=${SESSION_ID}`);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Resolution approved")).toBeVisible();
  await expect(page.getByText("saved as reusable memory")).toBeVisible();
  checkConsole();
});

test("disables chat when all three model-call reservations are used", async ({ page }) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({
      json: {
        investigation: {
          ...investigation("complete"),
          followUpCalls: 3,
          followUps: [],
        },
      },
    }),
  );

  await page.goto(`/?investigation=${SESSION_ID}`);
  await expect(page.getByText("0 of 3 follow-up calls remaining.")).toBeVisible();
  await expect(page.getByLabel("Ask about this diagnosis or its evidence")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Ask Bar" })).toBeDisabled();
  checkConsole();
});

test("restores an investigation from the URL without starting another workflow", async ({
  page,
}) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  let postCount = 0;
  await page.route("**/api/investigations", (route) => {
    postCount += 1;
    return route.abort();
  });
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({ json: { investigation: investigation("complete") } }),
  );

  await page.goto(`/?investigation=${SESSION_ID}`);
  await expect(page.getByRole("heading", { name: /package build cannot find/i })).toBeVisible();
  await expect(page.locator("#investigation-id")).toHaveAttribute("title", SESSION_ID);
  await expect(page.locator('input[value="link-pr-60-package-v1"]')).toBeChecked();
  expect(postCount).toBe(0);
  checkConsole();
});

test("makes a deep link read-only outside its owning demo session", async ({ page }) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({
      json: {
        investigation: {
          ...investigation("complete"),
          canMutate: false,
        },
      },
    }),
  );

  await page.goto(`/?investigation=${SESSION_ID}`);
  await expect(page.getByText("Read-only investigation")).toBeVisible();
  await expect(page.getByText(/Only the demo session that started/)).toBeVisible();
  await expect(page.getByLabel("Ask about this diagnosis or its evidence")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeHidden();
  await expect(page.getByText(/shared deep link is read-only/i)).toBeVisible();
  checkConsole();
});

test("starts the Windows fixture selected by the reviewer", async ({ page }) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  let selectedFixture = "";
  await page.route("**/api/investigations", async (route) => {
    selectedFixture = route.request().postDataJSON().fixtureId;
    await route.fulfill({
      status: 202,
      json: {
        investigation: {
          sessionId: SESSION_ID,
          fixtureId: selectedFixture,
          status: "queued",
          workflowInstanceId: null,
        },
      },
    });
  });
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({
      json: {
        investigation: {
          ...investigation("queued"),
          fixtureId: "link-pr-60-windows-smoke-v1",
        },
      },
    }),
  );

  await page.goto("/");
  await page.getByRole("radio", { name: /Windows Smoke/ }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Start investigation" }).click();
  await expect(page.locator("#investigation-id")).toHaveAttribute("title", SESSION_ID);
  expect(selectedFixture).toBe("link-pr-60-windows-smoke-v1");
  checkConsole();
});

test("renders evidence strings as text instead of executable HTML", async ({ page }) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  const payload = '<img src=x onerror="window.__barPwned=true">';
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({
      json: {
        investigation: {
          ...investigation("complete"),
          evidence: [{ ...evidence[0], content: payload }],
          evidenceIds: ["E-PKG-001"],
          diagnosis: {
            ...investigation("complete").diagnosis,
            evidenceIds: ["E-PKG-001"],
          },
        },
      },
    }),
  );

  await page.goto(`/?investigation=${SESSION_ID}`);
  await expect(page.locator("#evidence-1")).toContainText(payload);
  await expect(page.locator("#evidence-1 img")).toHaveCount(0);
  expect(await page.evaluate(() => "__barPwned" in window)).toBe(false);
  checkConsole();
});

test("shows a recoverable error instead of polling forever", async ({ page }) => {
  const checkConsole = await assertNoPageErrors(page, { allowFailedResource: true });
  await mockFixtureList(page);
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { message: "The investigation service is unavailable." } },
    }),
  );

  await page.goto(`/?investigation=${SESSION_ID}`);
  await expect(page.getByRole("alert")).toContainText("Investigation interrupted");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  checkConsole();
});

test("renders a terminal workflow failure without implying work continues", async ({
  page,
}) => {
  const checkConsole = await assertNoPageErrors(page);
  await mockFixtureList(page);
  await page.route(`**/api/investigations/${SESSION_ID}`, (route) =>
    route.fulfill({
      json: {
        investigation: {
          ...investigation("queued"),
          status: "failed",
          modelCalls: 1,
          error: "model_output_invalid",
        },
      },
    }),
  );

  await page.goto(`/?investigation=${SESSION_ID}`);
  await expect(page.getByText("Diagnosis stopped")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No diagnosis was produced." })).toBeVisible();
  await expect(page.getByText("without making another diagnosis attempt")).toBeVisible();
  await expect(page.getByText("Investigation in progress")).toHaveCount(0);
  checkConsole();
});

test("serves basic security headers on static assets and API responses", async ({
  request,
}) => {
  const pageResponse = await request.get("/");
  const apiResponse = await request.get("/api/fixtures");

  for (const response of [pageResponse, apiResponse]) {
    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toContain("camera=()");
  }
  expect(apiResponse.headers()["set-cookie"]).toContain("HttpOnly");
  expect(apiResponse.headers()["set-cookie"]).toContain("SameSite=Lax");
});
