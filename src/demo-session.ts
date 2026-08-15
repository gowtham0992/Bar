const DEMO_SESSION_COOKIE = "bar_demo_session";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const SCOPE_PATTERN = /^[a-f0-9]{64}$/;

export type DemoSession = {
  scopeId: string;
  setCookie: string | null;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readDemoSessionToken(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== DEMO_SESSION_COOKIE) continue;
    const value = valueParts.join("=");
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

export async function deriveDemoScopeId(token: string): Promise<string> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("invalid_demo_session_token");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`bar-public-demo\0${token}`),
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function readDemoSession(request: Request): Promise<DemoSession | null> {
  const token = readDemoSessionToken(request.headers.get("cookie"));
  return token === null
    ? null
    : { scopeId: await deriveDemoScopeId(token), setCookie: null };
}

export async function createDemoSession(request: Request): Promise<DemoSession> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = bytesToHex(bytes);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    scopeId: await deriveDemoScopeId(token),
    setCookie:
      `${DEMO_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
  };
}

export function isDemoScopeId(value: unknown): value is string {
  return typeof value === "string" && SCOPE_PATTERN.test(value);
}

export function demoMemoryAgentName(scopeId: string): string {
  if (!isDemoScopeId(scopeId)) throw new Error("invalid_demo_memory_scope");
  return `demo-memory-v1-${scopeId}`;
}

export function canMutateInvestigation(
  ownerScopeId: string | null,
  callerScopeId: string | null,
): boolean {
  return (
    ownerScopeId !== null &&
    callerScopeId !== null &&
    ownerScopeId === callerScopeId
  );
}
