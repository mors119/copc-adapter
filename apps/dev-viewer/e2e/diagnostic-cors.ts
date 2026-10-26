export type DiagnosticCredentialsMode = "omit" | "same-origin" | "include";

/** Range fetches use Fetch's default same-origin credentials mode. */
export function isVisibleResponseHeader(
  responseUrl: string,
  pageOrigin: string,
  headerName: string,
  responseHeaders: Record<string, string>,
  credentialsMode: DiagnosticCredentialsMode = "same-origin",
): boolean {
  let responseOrigin: string;
  try {
    responseOrigin = new URL(responseUrl).origin;
  } catch {
    return false;
  }
  if (responseOrigin === pageOrigin) return true;
  const allowedOrigin = responseHeaders["access-control-allow-origin"];
  if (allowedOrigin !== "*" && allowedOrigin !== pageOrigin) return false;
  if (allowedOrigin === "*" && credentialsMode === "include") return false;
  if (headerName === "content-length") return true;
  const exposed = (responseHeaders["access-control-expose-headers"] ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase());
  return (
    exposed.includes(headerName.toLowerCase()) ||
    (exposed.includes("*") && credentialsMode !== "include")
  );
}
