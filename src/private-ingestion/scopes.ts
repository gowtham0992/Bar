const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function requireRepository(repository: string): void {
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("invalid_repository");
}

export async function deriveRepositoryScope(repository: string): Promise<string> {
  requireRepository(repository);
  return sha256(`private-repository-v1\0${repository}`);
}

export async function deriveRepositoryMemoryScope(repository: string): Promise<string> {
  requireRepository(repository);
  return sha256(`private-repository-memory-v1\0${repository}`);
}

export async function derivePrivateInvestigationId(
  repository: string,
  deliveryId: string,
): Promise<string> {
  requireRepository(repository);
  if (!/^[a-f0-9]{64}$/.test(deliveryId)) throw new Error("invalid_delivery_id");
  return sha256(`private-investigation-v1\0${repository}\0${deliveryId}`);
}

export async function derivePrivateFailureKey(input: {
  repository: string;
  workflowPath: string;
  jobName: string;
  failedStep: string;
}): Promise<string> {
  requireRepository(input.repository);
  return sha256(
    [
      "private-failure-key-v1",
      input.repository,
      input.workflowPath,
      input.jobName,
      input.failedStep,
    ].join("\0"),
  );
}

export function derivePrivateWorkflowId(investigationId: string): string {
  if (!/^[a-f0-9]{64}$/.test(investigationId)) {
    throw new Error("invalid_investigation_id");
  }
  return `private-${investigationId}`;
}
