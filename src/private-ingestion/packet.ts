import { ApiInputError } from "../api";

export const PRIVATE_PACKET_SCHEMA_VERSION = 1 as const;
export const PRIVATE_PACKET_PRODUCER = "link-bar-action/v1" as const;
export const MAX_PRIVATE_PACKET_BYTES = 128 * 1024;
export const MAX_PRIVATE_EVIDENCE_BYTES = 64 * 1024;
export const MAX_PRIVATE_EVIDENCE_LINES = 400;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const EVIDENCE_ID_PATTERN = /^E-[A-Z0-9][A-Z0-9-]{0,62}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const TOKEN_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+\S+/i,
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s<]{8,}/i,
] as const;

const CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);
const CHANGE_STATUSES = new Set([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged",
]);
const EVIDENCE_KINDS = new Set([
  "job_log",
  "check_annotation",
  "source",
  "source_diff",
  "workflow",
]);
const SHA_ROLES = new Set(["base", "head", "base_to_head"]);

export type RedactionCounts = {
  credential: number;
  email: number;
  environment: number;
  path: number;
  url: number;
};

export type PrivateEvidenceItem = {
  id: string;
  kind: "job_log" | "check_annotation" | "source" | "source_diff" | "workflow";
  title: string;
  content: string;
  sequence: number;
  source: {
    job: string | null;
    step: string | null;
    path: string | null;
    sha_role: "base" | "head" | "base_to_head" | null;
    original_line_start: number;
    original_line_end: number;
  };
  redactions: RedactionCounts;
};

export type PrivateEvidencePacket = {
  schema_version: typeof PRIVATE_PACKET_SCHEMA_VERSION;
  capture: {
    code_repository: string;
    code_ref: "refs/heads/main";
    code_sha: string;
    workflow_path: ".github/workflows/bar-investigate.yml";
  };
  delivery: {
    id: string;
    producer: typeof PRIVATE_PACKET_PRODUCER;
    sent_at: string;
  };
  source: {
    repository: string;
    workflow: { id: number; name: string; path: string };
    run: {
      id: number;
      attempt: number;
      event: "pull_request" | "workflow_dispatch";
      head_sha: string;
      html_url: string;
    };
    pull_request: {
      number: number;
      base_sha: string;
      head_sha: string;
    } | null;
  };
  focus: { job_id: number; job_name: string; failed_step: string };
  job_summary: Array<{
    name: string;
    conclusion: string;
    steps: Array<{ name: string; conclusion: string }>;
  }>;
  change_summary: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  evidence: PrivateEvidenceItem[];
  missing_evidence: string[];
  sanitization: {
    version: 1;
    truncated: boolean;
    redaction_counts: RedactionCounts;
  };
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string, message: string): never {
  throw new ApiInputError("invalid_evidence_packet", 422, `${field}: ${message}`);
}

function record(value: unknown, field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(field, "must be an object");
  }
  return value as JsonRecord;
}

function exact(value: JsonRecord, fields: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(field, "contains missing or unknown fields");
  }
}

function text(
  value: unknown,
  field: string,
  maximumLength: number,
  options: { allowEmpty?: boolean; trim?: boolean } = {},
): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    return invalid(field, `must be a string no longer than ${maximumLength} characters`);
  }
  const output = options.trim === false ? value : value.trim();
  if ((!options.allowEmpty && output.length === 0) || UNSAFE_CONTROL_PATTERN.test(output)) {
    return invalid(field, "is empty or contains unsafe control characters");
  }
  return output;
}

function nullableText(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  return value === null ? null : text(value, field, maximumLength);
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function array(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    return invalid(field, `must be an array with at most ${maximum} items`);
  }
  return value;
}

function parseRedactions(value: unknown, field: string): RedactionCounts {
  const input = record(value, field);
  exact(input, ["credential", "email", "environment", "path", "url"], field);
  return {
    credential: integer(input.credential, `${field}.credential`, 0, 1_000_000),
    email: integer(input.email, `${field}.email`, 0, 1_000_000),
    environment: integer(input.environment, `${field}.environment`, 0, 1_000_000),
    path: integer(input.path, `${field}.path`, 0, 1_000_000),
    url: integer(input.url, `${field}.url`, 0, 1_000_000),
  };
}

function parseRepoPath(value: unknown, field: string): string {
  const path = text(value, field, 300);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    invalid(field, "must be a canonical repository-relative path");
  }
  assertNoSensitiveSurvivor(path, field);
  return path;
}

function parseSha(value: unknown, field: string): string {
  const sha = text(value, field, 40);
  if (!SHA_PATTERN.test(sha)) invalid(field, "must be a lowercase 40-character SHA");
  return sha;
}

function parseGithubUrl(value: unknown, field: string, repository: string): string {
  const raw = text(value, field, 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid(field, "must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(`/${repository}/`)
  ) {
    invalid(field, "must be a query-free public URL for the allowed repository");
  }
  return url.toString();
}

function assertNoSensitiveSurvivor(content: string, field: string): void {
  if (EMAIL_PATTERN.test(content) || TOKEN_PATTERNS.some((pattern) => pattern.test(content))) {
    invalid(field, "contains a value that should have been sanitized");
  }
  const urls = content.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  for (const raw of urls) {
    try {
      const url = new URL(raw.replace(/[),.;]+$/, ""));
      if (url.username || url.password || url.search || url.hash) {
        invalid(field, "contains a URL with credentials, query parameters, or a fragment");
      }
    } catch {
      invalid(field, "contains a malformed URL");
    }
  }
}

function sanitizedText(value: unknown, field: string, maximumLength: number): string {
  const output = text(value, field, maximumLength);
  assertNoSensitiveSurvivor(output, field);
  return output;
}

function nullableSanitizedText(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  return value === null ? null : sanitizedText(value, field, maximumLength);
}

export function assertModelBoundValueSanitized(
  value: unknown,
  field = "model_input",
): void {
  if (typeof value === "string") {
    assertNoSensitiveSurvivor(value, field);
    return;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertModelBoundValueSanitized(item, `${field}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertModelBoundValueSanitized(item, `${field}.${key}`);
    }
    return;
  }
  invalid(field, "contains a value that cannot be sent to the model");
}

function parseEvidence(value: unknown): PrivateEvidenceItem[] {
  const inputs = array(value, "evidence", 20);
  if (inputs.length === 0) invalid("evidence", "must contain at least one item");
  const ids = new Set<string>();
  const sequences = new Set<number>();
  let totalBytes = 0;
  let totalLines = 0;
  const evidence = inputs.map((item, index): PrivateEvidenceItem => {
    const field = `evidence[${index}]`;
    const input = record(item, field);
    exact(input, ["id", "kind", "title", "content", "sequence", "source", "redactions"], field);
    const id = text(input.id, `${field}.id`, 64);
    if (!EVIDENCE_ID_PATTERN.test(id) || ids.has(id)) {
      invalid(`${field}.id`, "must be a unique stable evidence ID");
    }
    ids.add(id);
    const kind = text(input.kind, `${field}.kind`, 40);
    if (!EVIDENCE_KINDS.has(kind)) invalid(`${field}.kind`, "is not allowed");
    const sequence = integer(input.sequence, `${field}.sequence`, 1, 20);
    if (sequences.has(sequence)) invalid(`${field}.sequence`, "must be unique");
    sequences.add(sequence);
    const content = text(input.content, `${field}.content`, 50_000, {
      trim: false,
    });
    const contentBytes = new TextEncoder().encode(content).byteLength;
    if (contentBytes > 12 * 1024) invalid(`${field}.content`, "exceeds 12 KiB");
    assertNoSensitiveSurvivor(content, `${field}.content`);
    totalBytes += contentBytes;
    totalLines += content.split("\n").length;

    const sourceInput = record(input.source, `${field}.source`);
    exact(
      sourceInput,
      ["job", "step", "path", "sha_role", "original_line_start", "original_line_end"],
      `${field}.source`,
    );
    const path = sourceInput.path === null
      ? null
      : parseRepoPath(sourceInput.path, `${field}.source.path`);
    const shaRole = nullableText(sourceInput.sha_role, `${field}.source.sha_role`, 20);
    if (shaRole !== null && !SHA_ROLES.has(shaRole)) {
      invalid(`${field}.source.sha_role`, "is not allowed");
    }
    const lineStart = integer(
      sourceInput.original_line_start,
      `${field}.source.original_line_start`,
      1,
      10_000_000,
    );
    const lineEnd = integer(
      sourceInput.original_line_end,
      `${field}.source.original_line_end`,
      lineStart,
      10_000_000,
    );
    return {
      id,
      kind: kind as PrivateEvidenceItem["kind"],
      title: sanitizedText(input.title, `${field}.title`, 160),
      content,
      sequence,
      source: {
        job: nullableSanitizedText(sourceInput.job, `${field}.source.job`, 160),
        step: nullableSanitizedText(sourceInput.step, `${field}.source.step`, 160),
        path,
        sha_role: shaRole as PrivateEvidenceItem["source"]["sha_role"],
        original_line_start: lineStart,
        original_line_end: lineEnd,
      },
      redactions: parseRedactions(input.redactions, `${field}.redactions`),
    };
  });
  if (totalBytes > MAX_PRIVATE_EVIDENCE_BYTES) {
    invalid("evidence", "exceeds the 64 KiB model-visible evidence limit");
  }
  if (totalLines > MAX_PRIVATE_EVIDENCE_LINES) {
    invalid("evidence", "exceeds the 400-line model-visible evidence limit");
  }
  const ordered = [...sequences].sort((left, right) => left - right);
  if (ordered.some((value, index) => value !== index + 1)) {
    invalid("evidence.sequence", "must be contiguous starting at 1");
  }
  return evidence.sort((left, right) => left.sequence - right.sequence);
}

export function parsePrivateEvidencePacket(value: unknown): PrivateEvidencePacket {
  const input = record(value, "packet");
  exact(
    input,
    [
      "schema_version",
      "capture",
      "delivery",
      "source",
      "focus",
      "job_summary",
      "change_summary",
      "evidence",
      "missing_evidence",
      "sanitization",
    ],
    "packet",
  );
  if (input.schema_version !== PRIVATE_PACKET_SCHEMA_VERSION) {
    invalid("schema_version", "is not supported");
  }

  const capture = record(input.capture, "capture");
  exact(
    capture,
    ["code_repository", "code_ref", "code_sha", "workflow_path"],
    "capture",
  );
  const captureRepository = text(
    capture.code_repository,
    "capture.code_repository",
    201,
  );
  if (!REPOSITORY_PATTERN.test(captureRepository)) {
    invalid("capture.code_repository", "must be an owner/repository name");
  }
  if (capture.code_ref !== "refs/heads/main") {
    invalid("capture.code_ref", "must identify the trusted main branch");
  }
  if (capture.workflow_path !== ".github/workflows/bar-investigate.yml") {
    invalid("capture.workflow_path", "is not the trusted capture workflow");
  }
  const captureSha = parseSha(capture.code_sha, "capture.code_sha");

  const delivery = record(input.delivery, "delivery");
  exact(delivery, ["id", "producer", "sent_at"], "delivery");
  const deliveryId = text(delivery.id, "delivery.id", 64);
  if (!HASH_PATTERN.test(deliveryId)) invalid("delivery.id", "must be a lowercase SHA-256");
  if (delivery.producer !== PRIVATE_PACKET_PRODUCER) {
    invalid("delivery.producer", "is not trusted");
  }
  const sentAt = text(delivery.sent_at, "delivery.sent_at", 40);
  if (!RFC3339_UTC_PATTERN.test(sentAt) || !Number.isFinite(Date.parse(sentAt))) {
    invalid("delivery.sent_at", "must be an RFC 3339 UTC timestamp");
  }

  const source = record(input.source, "source");
  exact(source, ["repository", "workflow", "run", "pull_request"], "source");
  const repository = text(source.repository, "source.repository", 201);
  if (!REPOSITORY_PATTERN.test(repository)) {
    invalid("source.repository", "must be an owner/repository name");
  }
  if (captureRepository !== repository) {
    invalid("capture.code_repository", "must match source.repository");
  }
  const workflow = record(source.workflow, "source.workflow");
  exact(workflow, ["id", "name", "path"], "source.workflow");
  const run = record(source.run, "source.run");
  exact(run, ["id", "attempt", "event", "head_sha", "html_url"], "source.run");
  const event = text(run.event, "source.run.event", 40);
  if (event !== "pull_request" && event !== "workflow_dispatch") {
    invalid("source.run.event", "is not allowed");
  }
  const headSha = parseSha(run.head_sha, "source.run.head_sha");

  let pullRequest: PrivateEvidencePacket["source"]["pull_request"] = null;
  if (source.pull_request !== null) {
    const pull = record(source.pull_request, "source.pull_request");
    exact(pull, ["number", "base_sha", "head_sha"], "source.pull_request");
    pullRequest = {
      number: integer(pull.number, "source.pull_request.number", 1, 1_000_000_000),
      base_sha: parseSha(pull.base_sha, "source.pull_request.base_sha"),
      head_sha: parseSha(pull.head_sha, "source.pull_request.head_sha"),
    };
    if (pullRequest.head_sha !== headSha) {
      invalid("source.pull_request.head_sha", "must match source.run.head_sha");
    }
  }
  if ((event === "pull_request") !== (pullRequest !== null)) {
    invalid("source.pull_request", "must be present only for pull_request runs");
  }

  const focus = record(input.focus, "focus");
  exact(focus, ["job_id", "job_name", "failed_step"], "focus");
  const parsedFocus = {
    job_id: integer(focus.job_id, "focus.job_id", 1, Number.MAX_SAFE_INTEGER),
    job_name: sanitizedText(focus.job_name, "focus.job_name", 160),
    failed_step: sanitizedText(focus.failed_step, "focus.failed_step", 160),
  };

  const jobs = array(input.job_summary, "job_summary", 50).map((item, jobIndex) => {
    const field = `job_summary[${jobIndex}]`;
    const job = record(item, field);
    exact(job, ["name", "conclusion", "steps"], field);
    const conclusion = text(job.conclusion, `${field}.conclusion`, 40);
    if (!CONCLUSIONS.has(conclusion)) invalid(`${field}.conclusion`, "is not allowed");
    return {
      name: sanitizedText(job.name, `${field}.name`, 160),
      conclusion,
      steps: array(job.steps, `${field}.steps`, 50).map((stepItem, stepIndex) => {
        const stepField = `${field}.steps[${stepIndex}]`;
        const step = record(stepItem, stepField);
        exact(step, ["name", "conclusion"], stepField);
        const stepConclusion = text(step.conclusion, `${stepField}.conclusion`, 40);
        if (!CONCLUSIONS.has(stepConclusion)) {
          invalid(`${stepField}.conclusion`, "is not allowed");
        }
        return {
          name: sanitizedText(step.name, `${stepField}.name`, 160),
          conclusion: stepConclusion,
        };
      }),
    };
  });
  const focusedJob = jobs.find((job) => job.name === parsedFocus.job_name);
  if (
    focusedJob?.conclusion !== "failure" ||
    !focusedJob.steps.some(
      (step) =>
        step.name === parsedFocus.failed_step && step.conclusion === "failure",
    )
  ) {
    invalid(
      "focus",
      "must identify a failed job and failed step in job_summary",
    );
  }

  const changes = array(input.change_summary, "change_summary", 100).map(
    (item, changeIndex) => {
      const field = `change_summary[${changeIndex}]`;
      const change = record(item, field);
      exact(change, ["path", "status", "additions", "deletions"], field);
      const status = text(change.status, `${field}.status`, 20);
      if (!CHANGE_STATUSES.has(status)) invalid(`${field}.status`, "is not allowed");
      return {
        path: parseRepoPath(change.path, `${field}.path`),
        status,
        additions: integer(change.additions, `${field}.additions`, 0, 1_000_000),
        deletions: integer(change.deletions, `${field}.deletions`, 0, 1_000_000),
      };
    },
  );

  const missing = array(input.missing_evidence, "missing_evidence", 20).map(
    (item, index) => {
      const value = text(item, `missing_evidence[${index}]`, 300);
      assertNoSensitiveSurvivor(value, `missing_evidence[${index}]`);
      return value;
    },
  );

  const sanitization = record(input.sanitization, "sanitization");
  exact(sanitization, ["version", "truncated", "redaction_counts"], "sanitization");
  if (sanitization.version !== 1 || typeof sanitization.truncated !== "boolean") {
    invalid("sanitization", "has an unsupported version or invalid truncation marker");
  }
  const evidence = parseEvidence(input.evidence);
  const redactionCounts = parseRedactions(
    sanitization.redaction_counts,
    "sanitization.redaction_counts",
  );
  const summedRedactions = evidence.reduce<RedactionCounts>(
    (total, item) => ({
      credential: total.credential + item.redactions.credential,
      email: total.email + item.redactions.email,
      environment: total.environment + item.redactions.environment,
      path: total.path + item.redactions.path,
      url: total.url + item.redactions.url,
    }),
    { credential: 0, email: 0, environment: 0, path: 0, url: 0 },
  );
  if (
    Object.keys(redactionCounts).some(
      (key) =>
        redactionCounts[key as keyof RedactionCounts] !==
        summedRedactions[key as keyof RedactionCounts],
    )
  ) {
    invalid(
      "sanitization.redaction_counts",
      "must equal the sum of evidence-item redactions",
    );
  }

  return {
    schema_version: PRIVATE_PACKET_SCHEMA_VERSION,
    capture: {
      code_repository: captureRepository,
      code_ref: "refs/heads/main",
      code_sha: captureSha,
      workflow_path: ".github/workflows/bar-investigate.yml",
    },
    delivery: {
      id: deliveryId,
      producer: PRIVATE_PACKET_PRODUCER,
      sent_at: sentAt,
    },
    source: {
      repository,
      workflow: {
        id: integer(workflow.id, "source.workflow.id", 1, Number.MAX_SAFE_INTEGER),
        name: sanitizedText(workflow.name, "source.workflow.name", 160),
        path: parseRepoPath(workflow.path, "source.workflow.path"),
      },
      run: {
        id: integer(run.id, "source.run.id", 1, Number.MAX_SAFE_INTEGER),
        attempt: integer(run.attempt, "source.run.attempt", 1, 1_000),
        event,
        head_sha: headSha,
        html_url: parseGithubUrl(run.html_url, "source.run.html_url", repository),
      },
      pull_request: pullRequest,
    },
    focus: parsedFocus,
    job_summary: jobs,
    change_summary: changes,
    evidence,
    missing_evidence: missing,
    sanitization: {
      version: 1,
      truncated: sanitization.truncated,
      redaction_counts: redactionCounts,
    },
  };
}

export async function deriveExpectedDeliveryId(
  packet: Pick<PrivateEvidencePacket, "source" | "focus">,
): Promise<string> {
  const input = [
    "github",
    packet.source.repository,
    String(packet.source.run.id),
    String(packet.source.run.attempt),
    String(packet.focus.job_id),
  ].join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export async function hashPrivatePacket(packet: PrivateEvidencePacket): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(packet)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
