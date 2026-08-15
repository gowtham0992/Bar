const POLL_INTERVAL_MS = 1_200;
const ID_PATTERN = /^[a-f0-9]{64}$/;
const investigationId = window.location.pathname.match(
  /^\/private\/investigations\/([a-f0-9]{64})$/,
)?.[1] ?? null;

const elements = {
  pageTitle: document.querySelector("#page-title"),
  context: document.querySelector("#investigation-context"),
  investigationId: document.querySelector("#investigation-id"),
  statusBadge: document.querySelector("#status-badge"),
  errorBanner: document.querySelector("#error-banner"),
  errorMessage: document.querySelector("#error-message"),
  retryButton: document.querySelector("#retry-button"),
  milestones: document.querySelector("#milestones"),
  workflowId: document.querySelector("#workflow-id"),
  diagnosisPending: document.querySelector("#diagnosis-pending"),
  diagnosisContent: document.querySelector("#diagnosis-content"),
  diagnosisTitle: document.querySelector("#diagnosis-title"),
  confidence: document.querySelector("#confidence"),
  diagnosisExplanation: document.querySelector("#diagnosis-explanation"),
  diagnosisCitations: document.querySelector("#diagnosis-citations"),
  uncertainty: document.querySelector("#uncertainty"),
  proposedResolution: document.querySelector("#proposed-resolution"),
  memoryAssessment: document.querySelector("#memory-assessment"),
  modelCallCount: document.querySelector("#model-call-count"),
  followUpCallCount: document.querySelector("#follow-up-call-count"),
  tokenUsage: document.querySelector("#token-usage"),
  evidenceCount: document.querySelector("#evidence-count"),
  evidenceList: document.querySelector("#evidence-list"),
  followUpBudget: document.querySelector("#follow-up-budget"),
  followUpHistory: document.querySelector("#follow-up-history"),
  followUpForm: document.querySelector("#follow-up-form"),
  followUpQuestion: document.querySelector("#follow-up-question"),
  followUpSubmit: document.querySelector("#follow-up-submit"),
  chatClosed: document.querySelector("#chat-closed"),
  reviewActions: document.querySelector("#review-actions"),
  approveButton: document.querySelector("#approve-button"),
  correctButton: document.querySelector("#correct-button"),
  rejectButton: document.querySelector("#reject-button"),
  correctionForm: document.querySelector("#correction-form"),
  correctedResolution: document.querySelector("#corrected-resolution"),
  cancelCorrection: document.querySelector("#cancel-correction"),
  reviewOutcome: document.querySelector("#review-outcome"),
};

let currentInvestigation = null;
let pollTimer = null;
let followUpBusy = false;
let reviewBusy = false;
let correctionOpen = false;
let pendingFollowUp = null;
let pendingReview = null;

function node(tag, className = "", text = "") {
  const value = document.createElement(tag);
  if (className) value.className = className;
  value.textContent = text;
  return value;
}

function display(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) =>
    letter.toUpperCase(),
  );
}

function clearError() {
  elements.errorBanner.hidden = true;
  elements.errorMessage.textContent = "";
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorBanner.hidden = false;
}

async function apiRequest(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(
      body?.error?.message ?? `The request failed with HTTP ${response.status}.`,
    );
    error.code = body?.error?.code ?? "request_failed";
    throw error;
  }
  return body;
}

function citationLinks(ids, evidence) {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return ids.map((id) => {
    const item = byId.get(id);
    const link = node("a", "citation", id);
    link.href = item ? `#evidence-${item.sequence}` : "#evidence-title";
    link.title = item?.title ?? "Evidence citation";
    return link;
  });
}

function renderHeader(investigation) {
  const focus = investigation.source.focus;
  elements.pageTitle.textContent =
    investigation.diagnosis?.summary ?? `${focus.job_name}: ${display(investigation.status)}`;
  document.title = `${focus.job_name} · Bar private investigation`;
  elements.context.textContent =
    `${investigation.repository} · ${investigation.source.workflow.name} · ` +
    `${focus.job_name} / ${focus.failed_step}`;
  elements.investigationId.textContent = investigation.id;
  elements.investigationId.title = investigation.id;
  elements.statusBadge.textContent = display(investigation.status);
  elements.statusBadge.dataset.status = investigation.status;
}

function renderProgress(investigation) {
  const labels = {
    load_evidence: "Load sanitized evidence",
    recall_memory: "Check reviewed repository memory",
    diagnose: "Diagnose with Workers AI",
  };
  elements.milestones.replaceChildren(
    ...investigation.milestones.map((milestone) => {
      const item = node(
        "li",
        milestone.status === "complete" ? "is-complete" : "",
        labels[milestone.stage] ?? display(milestone.stage),
      );
      item.prepend(node("span", "milestone-dot"));
      return item;
    }),
  );
  elements.workflowId.textContent = investigation.workflowInstanceId
    ? `Workflow ${investigation.workflowInstanceId}`
    : "Workflow start pending";
}

function renderDiagnosis(investigation) {
  const diagnosis = investigation.diagnosis;
  elements.diagnosisPending.hidden = diagnosis !== null;
  elements.diagnosisContent.hidden = diagnosis === null;
  if (!diagnosis) return;
  elements.diagnosisTitle.textContent = diagnosis.summary;
  elements.confidence.textContent = `${Math.round(diagnosis.confidence * 100)}% confidence`;
  elements.diagnosisExplanation.textContent = diagnosis.explanation;
  elements.diagnosisCitations.replaceChildren(
    ...citationLinks(diagnosis.evidenceIds, investigation.evidence),
  );
  elements.uncertainty.textContent = diagnosis.uncertainty;
  elements.proposedResolution.textContent = diagnosis.proposedResolution;
  const hasMemory = diagnosis.memoryAssessment !== "not_available";
  elements.memoryAssessment.hidden = !hasMemory;
  if (hasMemory) {
    elements.memoryAssessment.replaceChildren(
      node("strong", "", `Reviewed memory: ${display(diagnosis.memoryAssessment)}`),
      node("p", "", diagnosis.memoryExplanation),
    );
  }
}

function renderModelUsage(investigation) {
  elements.modelCallCount.textContent =
    `${investigation.modelCalls} of 1 diagnosis call used`;
  elements.followUpCallCount.textContent =
    `${investigation.followUpCalls} of ${investigation.followUpLimit} follow-up calls used`;
  const usage = investigation.modelUsage;
  const values = usage
    ? [usage.promptTokens, usage.completionTokens, usage.totalTokens]
    : [null, null, null];
  [...elements.tokenUsage.children].forEach((item, index) => {
    item.querySelector("strong").textContent =
      values[index] === null ? "—" : values[index].toLocaleString();
  });
}

function evidenceMetadata(item) {
  const source = item.source;
  return [
    source.job,
    source.step,
    source.path,
    source.original_line_start && source.original_line_end
      ? `lines ${source.original_line_start}–${source.original_line_end}`
      : null,
  ].filter(Boolean).join(" · ");
}

function renderEvidence(investigation) {
  const evidence = investigation.evidence;
  elements.evidenceCount.textContent = `${evidence.length} ${evidence.length === 1 ? "item" : "items"}`;
  elements.evidenceList.replaceChildren(
    ...evidence.map((item) => {
      const card = node("article", "evidence-card");
      card.id = `evidence-${item.sequence}`;
      const header = node("header");
      header.append(
        node("span", "section-kicker", `${item.id} · ${display(item.kind)}`),
        node("h3", "", item.title),
        node("div", "evidence-meta", evidenceMetadata(item)),
      );
      const content = node("pre");
      const code = node("code", "", item.content);
      content.append(code);
      card.append(header, content);
      return card;
    }),
  );
}

function renderFollowUps(investigation) {
  const remaining = Math.max(0, investigation.followUpLimit - investigation.followUpCalls);
  elements.followUpBudget.textContent = `${remaining} ${remaining === 1 ? "call" : "calls"} left`;
  const exchanges = investigation.followUps.map((exchange) => {
    const wrapper = node("article", "exchange");
    wrapper.append(node("strong", "", exchange.question));
    if (exchange.status === "pending") {
      wrapper.append(node("p", "answer", "Bar is answering…"));
    } else if (exchange.status === "failed") {
      wrapper.append(node("p", "answer", "This follow-up call failed and was not retried."));
    } else {
      wrapper.append(
        node("p", "answer", exchange.answer ?? ""),
        node("div", "citations"),
      );
      wrapper.lastElementChild.replaceChildren(
        ...citationLinks(exchange.evidenceIds, investigation.evidence),
      );
    }
    return wrapper;
  });
  elements.followUpHistory.replaceChildren(...exchanges);
  const reviewed = investigation.review !== null;
  const ready = investigation.status === "complete" && investigation.diagnosis !== null;
  elements.followUpForm.hidden = reviewed;
  elements.chatClosed.hidden = !reviewed;
  elements.followUpQuestion.disabled = !ready || followUpBusy || remaining === 0;
  elements.followUpSubmit.disabled = !ready || followUpBusy || remaining === 0;
  elements.followUpSubmit.textContent = followUpBusy ? "Asking…" : "Ask follow-up";
}

function reviewButtonsDisabled(disabled) {
  elements.approveButton.disabled = disabled;
  elements.correctButton.disabled = disabled;
  elements.rejectButton.disabled = disabled;
}

function renderReview(investigation) {
  const review = investigation.review;
  if (review) {
    elements.reviewActions.hidden = true;
    elements.correctionForm.hidden = true;
    elements.reviewOutcome.hidden = false;
    elements.reviewOutcome.classList.toggle("is-rejected", review.action === "reject");
    elements.reviewOutcome.replaceChildren(
      node(
        "strong",
        "",
        review.action === "reject" ? "Diagnosis rejected" : "Resolution approved",
      ),
      node(
        "p",
        "",
        review.memorySaved
          ? "This resolution is now reusable memory for this repository."
          : "The diagnosis remains in history and was not saved to memory.",
      ),
    );
    return;
  }
  const ready = investigation.status === "complete" && investigation.diagnosis !== null;
  elements.reviewActions.hidden = false;
  elements.reviewOutcome.hidden = true;
  elements.correctionForm.hidden = !correctionOpen;
  reviewButtonsDisabled(!ready || reviewBusy || investigation.followUps.some((item) => item.status === "pending"));
  if (correctionOpen && !elements.correctedResolution.value) {
    elements.correctedResolution.value = investigation.diagnosis?.proposedResolution ?? "";
  }
}

function renderInvestigation(investigation) {
  currentInvestigation = investigation;
  renderHeader(investigation);
  renderProgress(investigation);
  renderDiagnosis(investigation);
  renderModelUsage(investigation);
  renderEvidence(investigation);
  renderFollowUps(investigation);
  renderReview(investigation);
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  if (!document.hidden && investigationId) {
    pollTimer = window.setTimeout(loadInvestigation, POLL_INTERVAL_MS);
  }
}

async function loadInvestigation() {
  if (!investigationId) return;
  try {
    const body = await apiRequest(`/api/v1/private/investigations/${investigationId}`);
    clearError();
    renderInvestigation(body.investigation);
    if (
      !["complete", "failed"].includes(body.investigation.status) ||
      body.investigation.followUps.some((item) => item.status === "pending")
    ) {
      schedulePoll();
    }
  } catch (error) {
    showError(error.message);
  }
}

async function submitFollowUp(event) {
  event.preventDefault();
  if (!investigationId || followUpBusy || !currentInvestigation) return;
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
    await apiRequest(
      `/api/v1/private/investigations/${investigationId}/follow-ups`,
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
    await loadInvestigation();
  } catch (error) {
    showError(error.message);
  } finally {
    followUpBusy = false;
    if (currentInvestigation) renderFollowUps(currentInvestigation);
  }
}

async function submitReview(action, resolution = null) {
  if (!investigationId || reviewBusy || !currentInvestigation) return;
  const signature = `${action}\0${resolution ?? ""}`;
  if (!pendingReview || pendingReview.signature !== signature) {
    pendingReview = {
      signature,
      key: crypto.randomUUID().replaceAll("-", ""),
    };
  }
  reviewBusy = true;
  clearError();
  reviewButtonsDisabled(true);
  try {
    const response = await apiRequest(
      `/api/v1/private/investigations/${investigationId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": pendingReview.key,
        },
        body: JSON.stringify(
          action === "correct_and_approve" ? { action, resolution } : { action },
        ),
      },
    );
    pendingReview = null;
    correctionOpen = false;
    currentInvestigation = { ...currentInvestigation, review: response.review };
    renderInvestigation(currentInvestigation);
  } catch (error) {
    showError(error.message);
  } finally {
    reviewBusy = false;
    if (currentInvestigation) renderReview(currentInvestigation);
  }
}

elements.followUpForm.addEventListener("submit", submitFollowUp);
elements.approveButton.addEventListener("click", () => submitReview("approve"));
elements.rejectButton.addEventListener("click", () => submitReview("reject"));
elements.correctButton.addEventListener("click", () => {
  correctionOpen = true;
  renderReview(currentInvestigation);
  elements.correctedResolution.focus();
});
elements.cancelCorrection.addEventListener("click", () => {
  correctionOpen = false;
  elements.correctionForm.hidden = true;
});
elements.correctionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const resolution = elements.correctedResolution.value.trim();
  if (resolution) submitReview("correct_and_approve", resolution);
});
elements.retryButton.addEventListener("click", () => {
  clearError();
  loadInvestigation();
});
document.addEventListener("visibilitychange", () => {
  window.clearTimeout(pollTimer);
  if (!document.hidden) loadInvestigation();
});

if (!investigationId || !ID_PATTERN.test(investigationId)) {
  showError("This private investigation URL is invalid.");
} else {
  elements.investigationId.textContent = investigationId;
  elements.investigationId.title = investigationId;
  loadInvestigation();
}
