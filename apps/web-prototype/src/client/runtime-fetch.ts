let sessionToken: string | null = null;
let sessionPromise: Promise<string> | null = null;

async function createSession(): Promise<string> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
    credentials: "same-origin",
  });
  const result = await response.json() as { token?: string; error?: string };
  if (!response.ok || typeof result.token !== "string" || !result.token) {
    throw new Error(result.error || "无法建立本机 Runtime 会话");
  }
  sessionToken = result.token;
  return result.token;
}

async function getSessionToken(): Promise<string> {
  if (sessionToken) return sessionToken;
  if (!sessionPromise) {
    sessionPromise = createSession().finally(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

async function requestWithToken(input: RequestInfo | URL, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-ai-team-session", token);
  return fetch(input, { ...init, headers, credentials: "same-origin" });
}

export async function runtimeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  let response = await requestWithToken(input, init, await getSessionToken());
  if (response.status === 401) {
    sessionToken = null;
    response = await requestWithToken(input, init, await getSessionToken());
  }
  return response;
}
