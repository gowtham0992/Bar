import { ApiInputError } from "./api";

export const MAX_PUBLIC_REQUEST_BYTES = 4_096;

export async function parsePublicJsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new ApiInputError(
      "unsupported_media_type",
      415,
      "Content-Type must be application/json.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PUBLIC_REQUEST_BYTES
  ) {
    throw new ApiInputError("request_too_large", 413, "Request body is too large.");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader !== undefined) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PUBLIC_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ApiInputError(
          "request_too_large",
          413,
          "Request body is too large.",
        );
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiInputError("invalid_json", 400, "Request body is not valid JSON.");
  }
}
