const POLL_INTERVAL_MS = 2_000;
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

const elements = {
  form: document.querySelector("#fixture-form"),
  fixtureOptions: document.querySelector("#fixture-options"),
  startButton: document.querySelector("#start-button"),
  selectionNote: document.querySelector("#selection-note"),
  investigation: document.querySelector("#investigation"),
  investigationId: document.querySelector("#investigation-id"),
  statusBadge: document.querySelector("#status-badge"),
  progressList: document.querySelector("#progress-list"),
  progressNote: document.querySelector("#progress-note"),
  diagnosisContent: document.querySelector("#diagnosis-content"),
  evidenceList: document.querySelector("#evidence-list"),
  evidenceSummary: document.querySelector("#evidence-summary"),
  errorBanner: document.querySelector("#error-banner"),
  errorMessage: document.querySelector("#error-message"),
  retryButton: document.querySelector("#retry-button"),
  followUpSection: document.querySelector("#follow-up-section"),
  followUpList: document.querySelector("#follow-up-list"),
  followUpForm: document.querySelector("#follow-up-form"),
  followUpQuestion: document.querySelector("#follow-up-question"),
  followUpButton: document.querySelector("#follow-up-button"),
  followUpLimit: document.querySelector("#follow-up-limit"),
  followUpNote: document.querySelector("#follow-up-note"),
  reviewSection: document.querySelector("#review-section"),
  proposedResolution: document.querySelector("#proposed-resolution"),
  resolutionLabel: document.querySelector("#resolution-label"),
  reviewActions: document.querySelector("#review-actions"),
  approveButton: document.querySelector("#approve-button"),
  correctButton: document.querySelector("#correct-button"),
  rejectButton: document.querySelector("#reject-button"),
  correctionForm: document.querySelector("#correction-form"),
  correctedResolution: document.querySelector("#corrected-resolution"),
  cancelCorrection: document.querySelector("#cancel-correction"),
  reviewOutcome: document.querySelector("#review-outcome"),
};

let activeSessionId = null;
let pollTimer = null;
let requestGeneration = 0;
let currentInvestigation = null;
let investigationStarting = false;
let followUpBusy = false;
let pendingFollowUp = null;
let reviewBusy = false;
let pendingReview = null;
let correctionOpen = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function displayJobName(job) {
  return job
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function apiRequest(path, options) {
  const response = await fetch(path, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The generic fallback below is safer than reflecting an upstream body.
  }
  if (!response.ok) {
    const error = new Error(
      body?.error?.message ?? "The investigation service is unavailable.",
    );
    error.retryAfter = Number(response.headers.get("retry-after") ?? "0");
    throw error;
  }
  return body;
}

function renderFixtures(fixtures) {
  const fragment = document.createDocumentFragment();
  fixtures.forEach((fixture, index) => {
    const wrapper = element("div", "fixture-option");
    const input = element("input");
    input.type = "radio";
    input.name = "fixtureId";
    input.id = `fixture-${index}`;
    input.value = fixture.fixtureId;
    input.required = true;

    const label = element("label", "fixture-card");
    label.htmlFor = input.id;
    label.append(
      element("span", "fixture-number", `0${index + 1} / ${fixture.job}`),
      element("strong", "", displayJobName(fixture.job)),
      element("small", "", fixture.failedStep),
    );
    const meta = element("span", "fixture-meta");
    meta.append(
      element("span", "", `${fixture.evidenceCount} evidence items`),
      element("span", "", fixture.hasKnownGap ? "Known evidence gap" : "Evidence complete"),
      fixture.scenarioKind === "synthetic_replay"
        ? element("span", "fixture-scenario", "Synthetic similar replay")
        : element("span", "", "Captured failure"),
    );
    label.append(meta);
    wrapper.append(input, label);
    fragment.append(wrapper);
  });
  elements.fixtureOptions.replaceChildren(fragment);
  if (currentInvestigation?.fixtureId) {
    selectFixtureOption(currentInvestigation.fixtureId);
  }
  syncStartButton();
}

function selectFixtureOption(fixtureId) {
  for (const input of elements.fixtureOptions.querySelectorAll('input[name="fixtureId"]')) {
    input.checked = input.value === fixtureId;
  }
  syncStartButton();
}

function syncStartButton() {
  const fixtureSelected = elements.form.querySelector(
    'input[name="fixtureId"]:checked',
  );
  elements.startButton.disabled = investigationStarting || fixtureSelected === null;
}

function showError(message, retryAfter = 0) {
  elements.errorMessage.textContent = retryAfter > 0
    ? `${message} Retry in about ${retryAfter} seconds.`
    : message;
  elements.errorBanner.hidden = false;
}

function clearError() {
  elements.errorBanner.hidden = true;
  elements.errorMessage.textContent = "";
}

function setSessionInUrl(sessionId) {
  const url = new URL(window.location.href);
  url.searchParams.set("investigation", sessionId);
  window.history.replaceState({ investigation: sessionId }, "", url);
}

function revealInvestigation(sessionId) {
  activeSessionId = sessionId;
  elements.investigation.hidden = false;
  elements.investigationId.textContent = sessionId;
  elements.investigationId.title = sessionId;
}

function milestoneComplete(investigation, stage) {
  return investigation.milestones?.some(
    (milestone) => milestone.stage === stage && milestone.status === "complete",
  );
}

function renderProgress(investigation) {
  const terminal = investigation.status === "complete" || investigation.status === "failed";
  const stages = [
    {
      label: "Investigation queued",
      detail: "Session accepted",
      complete: investigation.status !== "queued",
      active: investigation.status === "queued",
    },
    {
      label: "Evidence loaded",
      detail: "Sanitized fixture context",
      complete: milestoneComplete(investigation, "load_evidence"),
      active: investigation.status === "collecting",
    },
    {
      label: "Reviewed memory checked",
      detail: investigation.memoryMatch
        ? "Approved match found"
        : "Approved matches only",
      complete: milestoneComplete(investigation, "recall_memory"),
      active:
        milestoneComplete(investigation, "load_evidence") &&
        !milestoneComplete(investigation, "recall_memory"),
    },
    {
      label: "Workers AI diagnosis",
      detail: "One diagnosis call maximum",
      complete: investigation.status === "complete",
      active: investigation.status === "diagnosing" || investigation.status === "failed",
    },
  ];

  const fragment = document.createDocumentFragment();
  stages.forEach((stage) => {
    const item = element("li");
    if (stage.complete) item.classList.add("is-complete");
    if (stage.active && !terminal) item.classList.add("is-active");
    const dot = element("span", "progress-dot", stage.complete ? "✓" : "");
    dot.setAttribute("aria-hidden", "true");
    item.append(
      dot,
      element("span", "progress-label", stage.label),
      element("span", "progress-detail", stage.detail),
    );
    fragment.append(item);
  });
  elements.progressList.replaceChildren(fragment);
  elements.progressNote.textContent = terminal
    ? investigation.status === "complete"
      ? `Complete · ${investigation.modelCalls} of 1 diagnosis call used`
      : "Stopped without another diagnosis attempt"
    : "Polling by investigation ID · Workflow ID is not required";
}

function renderPendingDiagnosis(status) {
  const wrapper = element("div", "diagnosis-empty");
  if (status === "failed") wrapper.classList.add("is-failed");
  const copy = element("div");
  copy.append(
    element(
      "span",
      "outcome-label",
      status === "failed"
        ? "Diagnosis stopped"
        : status === "queued"
          ? "Waiting to start"
          : "Investigation in progress",
    ),
    element(
      "h3",
      "",
      status === "failed"
        ? "No diagnosis was produced."
        : status === "diagnosing"
          ? "Reading the failure against the available evidence."
          : "Building an evidence-bound investigation.",
    ),
  );
  const lower = element("div");
  lower.append(
    element(
      "p",
      "",
      status === "failed"
        ? "The investigation stopped without making another diagnosis attempt."
        : "Bar will separate what the evidence proves from what remains uncertain.",
    ),
  );
  const skeleton = element("div", "skeleton-stack");
  skeleton.setAttribute("aria-hidden", "true");
  skeleton.append(element("div", "skeleton-line"), element("div", "skeleton-line"), element("div", "skeleton-line"));
  if (status !== "failed") lower.append(skeleton);
  wrapper.append(copy, lower);
  elements.diagnosisContent.replaceChildren(wrapper);
}

function renderDiagnosis(investigation) {
  const diagnosis = investigation.diagnosis;
  if (investigation.status !== "complete" || !diagnosis) {
    renderPendingDiagnosis(investigation.status);
    return;
  }

  const wrapper = element("div", "diagnosis-result");
  wrapper.append(
    element("span", "outcome-label", diagnosis.outcome === "diagnosed" ? "Diagnosis ready" : "Insufficient evidence"),
    element("h3", "diagnosis-summary", diagnosis.summary),
    element("p", "diagnosis-explanation", diagnosis.explanation),
  );

  const metrics = element("div", "diagnosis-metrics");
  const confidence = element("div", "metric");
  confidence.append(
    element("span", "", "Confidence"),
    element("strong", "", `${Math.round(diagnosis.confidence * 100)}%`),
  );
  const uncertainty = element("div", "uncertainty");
  uncertainty.append(
    element("span", "", "What remains uncertain"),
    element("p", "", diagnosis.uncertainty),
  );
  metrics.append(confidence, uncertainty);
  wrapper.append(metrics);

  if (investigation.memoryMatch) {
    const memory = investigation.memoryMatch;
    const memoryContext = element("section", "memory-context");
    memoryContext.setAttribute("aria-label", "Reviewed memory match");
    const source = element("div", "memory-context-source");
    source.append(
      element("span", "outcome-label", "Reviewed memory match"),
      element("strong", "", "Previously approved investigation"),
      element(
        "code",
        "memory-source-id",
        `${memory.sourceFixtureId} · ${memory.sourceInvestigationId.slice(0, 12)}…`,
      ),
    );
    const evaluation = element("div", "memory-context-evaluation");
    evaluation.append(
      element(
        "span",
        "memory-assessment",
        (diagnosis.memoryAssessment ?? "evaluated").replaceAll("_", " "),
      ),
      element("p", "memory-resolution", memory.resolution),
      element(
        "p",
        "memory-explanation",
        diagnosis.memoryExplanation ?? "The current diagnosis was evaluated independently.",
      ),
      element(
        "small",
        "",
        "Prior memory is context only. Citations below refer to this investigation’s current evidence.",
      ),
    );
    memoryContext.append(source, evaluation);
    wrapper.append(memoryContext);
  }

  const citations = element("div", "citation-list");
  citations.setAttribute("aria-label", "Cited evidence");
  diagnosis.evidenceIds.forEach((evidenceId) => {
    const anchor = element("a", "", evidenceId);
    const target = investigation.evidence?.findIndex((item) => item.id === evidenceId) ?? -1;
    if (target >= 0) anchor.href = `#evidence-${target + 1}`;
    citations.append(anchor);
  });
  wrapper.append(citations);
  elements.diagnosisContent.replaceChildren(wrapper);
}

function sourceLabel(source) {
  const location = source.path ?? source.job ?? "captured output";
  const lines = source.original_line_start > 0
    ? ` · lines ${source.original_line_start}–${source.original_line_end}`
    : "";
  return `${location}${lines}`;
}

function renderEvidence(investigation) {
  const evidence = investigation.evidence ?? [];
  const citedIds = new Set(investigation.diagnosis?.evidenceIds ?? []);
  if (evidence.length === 0) {
    elements.evidenceList.replaceChildren(
      element("p", "evidence-placeholder", "Waiting for sanitized evidence…"),
    );
    elements.evidenceSummary.textContent = "Evidence appears as the Workflow loads it.";
    return;
  }

  const fragment = document.createDocumentFragment();
  evidence.forEach((item, index) => {
    const article = element("article", "evidence-item");
    article.id = `evidence-${index + 1}`;
    const cited = citedIds.has(item.id);
    if (cited) article.classList.add("is-cited");

    const indexBlock = element("div");
    indexBlock.append(
      element("span", "evidence-id", item.id),
      element("span", "evidence-kind", item.kind.replaceAll("_", " ")),
    );
    if (cited) indexBlock.append(element("span", "cited-marker", "Cited"));

    const body = element("div", "evidence-body");
    body.append(
      element("h3", "", item.title),
      element("p", "evidence-source", sourceLabel(item.source)),
      element("pre", "evidence-content", item.content),
    );
    article.append(indexBlock, body);
    fragment.append(article);
  });
  elements.evidenceList.replaceChildren(fragment);
  elements.evidenceSummary.textContent = `${evidence.length} sanitized items · ${citedIds.size} cited in the diagnosis`;
}

function appendCitations(container, evidenceIds, investigation) {
  const citations = element("div", "citation-list");
  citations.setAttribute("aria-label", "Cited evidence");
  evidenceIds.forEach((evidenceId) => {
    const anchor = element("a", "", evidenceId);
    const target = investigation.evidence?.findIndex((item) => item.id === evidenceId) ?? -1;
    if (target >= 0) anchor.href = `#evidence-${target + 1}`;
    citations.append(anchor);
  });
  container.append(citations);
}

function renderFollowUps(investigation) {
  const ready = investigation.status === "complete" && investigation.diagnosis;
  elements.followUpSection.hidden = !ready;
  if (!ready) return;

  const followUps = investigation.followUps ?? [];
  const fragment = document.createDocumentFragment();
  followUps.forEach((exchange, index) => {
    const article = element("article", "follow-up-exchange");
    article.append(element("div", "follow-up-label", `Question ${index + 1}`));
    const body = element("div");
    body.append(element("p", "follow-up-question", exchange.question));
    if (exchange.status === "complete" && exchange.answer) {
      body.append(element("p", "follow-up-answer", exchange.answer));
      appendCitations(body, exchange.evidenceIds ?? [], investigation);
    } else if (exchange.status === "pending") {
      body.append(element("p", "follow-up-answer", "Answer in progress…"));
    } else {
      body.append(
        element(
          "p",
          "follow-up-answer",
          "This call failed and was not retried. You can ask another question if a slot remains.",
        ),
      );
    }
    article.append(body);
    fragment.append(article);
  });
  elements.followUpList.replaceChildren(fragment);

  const used = investigation.followUpCalls ?? 0;
  const remaining = Math.max(0, 3 - used);
  const readOnly = investigation.canMutate === false;
  const closed = Boolean(investigation.review) || readOnly;
  elements.followUpLimit.textContent = `${remaining} of 3 follow-up calls remaining.`;
  elements.followUpQuestion.disabled = followUpBusy || remaining === 0 || closed;
  elements.followUpButton.disabled = followUpBusy || remaining === 0 || closed;
  elements.followUpButton.firstChild.textContent = followUpBusy ? "Asking… " : "Ask Bar ";
  elements.followUpNote.textContent = readOnly
    ? "This shared deep link is read-only. Start a fixture in this browser to use follow-up chat."
    : investigation.review
      ? "Follow-up chat closed when this review was finalized."
      : remaining === 0
        ? "This investigation has reached its hard follow-up limit."
        : "Answers use the same sanitized evidence shown above.";
}

function setReviewButtonsDisabled(disabled) {
  elements.approveButton.disabled = disabled;
  elements.correctButton.disabled = disabled;
  elements.rejectButton.disabled = disabled;
}

function renderReview(investigation) {
  const ready = investigation.status === "complete" && investigation.diagnosis;
  elements.reviewSection.hidden = !ready;
  if (!ready) return;

  const proposed = investigation.diagnosis.proposedResolution ?? "";
  const review = investigation.review;
  elements.resolutionLabel.textContent = review?.memorySaved
    ? "Approved resolution"
    : "Proposed resolution";
  elements.proposedResolution.textContent = review?.memorySaved
    ? review.resolution
    : proposed || "No proposed resolution is available.";
  if (review) {
    elements.reviewActions.hidden = true;
    elements.correctionForm.hidden = true;
    elements.reviewOutcome.hidden = false;
    elements.reviewOutcome.classList.toggle("is-rejected", review.action === "reject");
    elements.reviewOutcome.replaceChildren(
      element(
        "strong",
        "",
        review.action === "reject" ? "Diagnosis rejected" : "Resolution approved",
      ),
      element(
        "p",
        "",
        review.memorySaved
          ? "This approved resolution was saved as reusable memory."
          : "The diagnosis remains in this investigation history and was not saved to memory.",
      ),
    );
    return;
  }

  if (investigation.canMutate === false) {
    elements.reviewActions.hidden = true;
    elements.correctionForm.hidden = true;
    elements.reviewOutcome.hidden = false;
    elements.reviewOutcome.classList.remove("is-rejected");
    elements.reviewOutcome.replaceChildren(
      element("strong", "", "Read-only investigation"),
      element(
        "p",
        "",
        "Only the demo session that started this investigation can review it or save reusable memory.",
      ),
    );
    return;
  }

  elements.reviewActions.hidden = false;
  elements.reviewOutcome.hidden = true;
  elements.correctionForm.hidden = !correctionOpen;
  elements.approveButton.disabled = reviewBusy || proposed.length === 0;
  elements.correctButton.disabled = reviewBusy;
  elements.rejectButton.disabled = reviewBusy;
  if (correctionOpen && !elements.correctedResolution.value) {
    elements.correctedResolution.value = proposed;
  }
}

function renderInvestigation(investigation) {
  currentInvestigation = investigation;
  revealInvestigation(investigation.sessionId);
  if (investigation.fixtureId) selectFixtureOption(investigation.fixtureId);
  elements.statusBadge.textContent = displayJobName(investigation.status);
  elements.statusBadge.dataset.status = investigation.status;
  renderProgress(investigation);
  renderDiagnosis(investigation);
  renderEvidence(investigation);
  renderFollowUps(investigation);
  renderReview(investigation);
}

function schedulePoll(delay = POLL_INTERVAL_MS) {
  window.clearTimeout(pollTimer);
  if (!document.hidden && activeSessionId) {
    pollTimer = window.setTimeout(() => pollInvestigation(activeSessionId), delay);
  }
}

async function pollInvestigation(sessionId) {
  const generation = ++requestGeneration;
  try {
    const body = await apiRequest(`/api/investigations/${sessionId}`);
    if (generation !== requestGeneration || sessionId !== activeSessionId) return;
    clearError();
    renderInvestigation(body.investigation);
    const hasPendingFollowUp = body.investigation.followUps?.some(
      (item) => item.status === "pending",
    );
    if (!["complete", "failed"].includes(body.investigation.status) || hasPendingFollowUp) {
      schedulePoll();
    }
  } catch (error) {
    if (generation !== requestGeneration || sessionId !== activeSessionId) return;
    const retryAfter = Number.isFinite(error.retryAfter) ? error.retryAfter : 0;
    showError(error.message, retryAfter);
    if (retryAfter > 0) schedulePoll(retryAfter * 1_000);
  }
}

async function startInvestigation(event) {
  event.preventDefault();
  clearError();
  const fixtureId = new FormData(elements.form).get("fixtureId");
  if (typeof fixtureId !== "string") return;

  investigationStarting = true;
  syncStartButton();
  elements.startButton.firstElementChild.textContent = "Starting…";
  try {
    const body = await apiRequest("/api/investigations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID().replaceAll("-", ""),
      },
      body: JSON.stringify({ fixtureId }),
    });
    const sessionId = body.investigation.sessionId;
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("The service returned an invalid investigation ID.");
    renderInvestigation({
      ...body.investigation,
      milestones: [],
      diagnosis: null,
      modelCalls: 0,
      followUpCalls: 0,
      followUps: [],
      review: null,
      evidence: [],
    });
    setSessionInUrl(sessionId);
    elements.investigation.scrollIntoView({ behavior: "smooth", block: "start" });
    await pollInvestigation(sessionId);
  } catch (error) {
    showError(error.message, Number.isFinite(error.retryAfter) ? error.retryAfter : 0);
  } finally {
    investigationStarting = false;
    syncStartButton();
    elements.startButton.firstElementChild.textContent = "Start investigation";
  }
}

async function submitFollowUp(event) {
  event.preventDefault();
  if (!activeSessionId || followUpBusy || !currentInvestigation) return;
  const question = elements.followUpQuestion.value.trim();
  if (!question) return;
  if (!pendingFollowUp || pendingFollowUp.question !== question) {
    pendingFollowUp = {
      question,
      key: crypto.randomUUID().replaceAll("-", ""),
    };
  }

  followUpBusy = true;
  clearError();
  renderFollowUps(currentInvestigation);
  try {
    const body = await apiRequest(
      `/api/investigations/${activeSessionId}/follow-ups`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pendingFollowUp.key,
        },
        body: JSON.stringify({ question: pendingFollowUp.question }),
      },
    );
    pendingFollowUp = null;
    elements.followUpQuestion.value = "";
    await pollInvestigation(activeSessionId);
    if (body.followUp?.status === "pending") schedulePoll();
  } catch (error) {
    showError(error.message, Number.isFinite(error.retryAfter) ? error.retryAfter : 0);
  } finally {
    followUpBusy = false;
    if (currentInvestigation) renderFollowUps(currentInvestigation);
  }
}

async function submitReview(action, resolution = null) {
  if (!activeSessionId || reviewBusy || !currentInvestigation) return;
  const signature = `${action}\0${resolution ?? ""}`;
  if (!pendingReview || pendingReview.signature !== signature) {
    pendingReview = {
      signature,
      key: crypto.randomUUID().replaceAll("-", ""),
    };
  }
  const body = action === "correct_and_approve"
    ? { action, resolution }
    : { action };

  reviewBusy = true;
  clearError();
  setReviewButtonsDisabled(true);
  try {
    const response = await apiRequest(
      `/api/investigations/${activeSessionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pendingReview.key,
        },
        body: JSON.stringify(body),
      },
    );
    pendingReview = null;
    correctionOpen = false;
    currentInvestigation = { ...currentInvestigation, review: response.review };
    renderInvestigation(currentInvestigation);
  } catch (error) {
    showError(error.message, Number.isFinite(error.retryAfter) ? error.retryAfter : 0);
  } finally {
    reviewBusy = false;
    if (currentInvestigation) renderReview(currentInvestigation);
  }
}

function submitCorrection(event) {
  event.preventDefault();
  const resolution = elements.correctedResolution.value.trim();
  if (resolution) submitReview("correct_and_approve", resolution);
}

async function loadFixtures() {
  try {
    const body = await apiRequest("/api/fixtures");
    renderFixtures(body.fixtures);
  } catch (error) {
    elements.fixtureOptions.replaceChildren(
      element("p", "evidence-placeholder", "Fixtures could not be loaded."),
    );
    elements.selectionNote.textContent = "Refresh the page to try loading fixtures again.";
    showError(error.message, Number.isFinite(error.retryAfter) ? error.retryAfter : 0);
  }
}

elements.form.addEventListener("submit", startInvestigation);
elements.fixtureOptions.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === "fixtureId") {
    syncStartButton();
  }
});
elements.followUpForm.addEventListener("submit", submitFollowUp);
elements.approveButton.addEventListener("click", () => submitReview("approve"));
elements.rejectButton.addEventListener("click", () => submitReview("reject"));
elements.correctButton.addEventListener("click", () => {
  correctionOpen = true;
  if (currentInvestigation) renderReview(currentInvestigation);
  elements.correctedResolution.focus();
});
elements.cancelCorrection.addEventListener("click", () => {
  correctionOpen = false;
  elements.correctionForm.hidden = true;
});
elements.correctionForm.addEventListener("submit", submitCorrection);
elements.retryButton.addEventListener("click", () => {
  clearError();
  if (activeSessionId) pollInvestigation(activeSessionId);
  else loadFixtures();
});
document.addEventListener("visibilitychange", () => {
  window.clearTimeout(pollTimer);
  if (!document.hidden && activeSessionId) pollInvestigation(activeSessionId);
});

const initialSessionId = new URL(window.location.href).searchParams.get("investigation");
if (initialSessionId && SESSION_ID_PATTERN.test(initialSessionId)) {
  revealInvestigation(initialSessionId);
  renderPendingDiagnosis("queued");
  pollInvestigation(initialSessionId);
}
loadFixtures();
