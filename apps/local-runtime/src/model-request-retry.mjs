import { setTimeout as delay } from "node:timers/promises";

function retryableProviderError(message) {
  if (!message || /quota|billing|credit|insufficient|余额|配额|unauthorized|authentication|invalid api key/i.test(message)) return false;
  return /\b(?:429|500|502|503|504)\s*:/.test(message)
    || /Endpoint is unavailable|upstream.*unavailable|temporarily unavailable|upstream.*overload|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);
}

function transientFailure(completion) {
  if (completion?.stopReason !== "error") return false;
  // Never replay a response that already emitted content or tool calls.
  if (completion.content?.some((block) => !["text", "thinking"].includes(block.type) || block.text?.trim() || block.thinking?.trim())) return false;
  return retryableProviderError(completion.errorMessage || "");
}

export async function completeWithTransientRetry(request, { wait = delay, now = Date.now, signal, maxAttempts = 3, jitter = false } = {}) {
  const started = now();
  let completion;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    const remainingMs = 120000 - (now() - started);
    if (remainingMs <= 0) break;
    attempts = attempt;
    try {
      completion = await request({ attempt, timeoutMs: remainingMs });
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (!retryableProviderError(message) || attempt === maxAttempts) {
        if (error && typeof error === "object") {
          error.attempts = attempt;
          error.elapsedMs = now() - started;
        }
        throw error;
      }
    }
    if (completion && (!transientFailure(completion) || attempt === maxAttempts)) {
      return { completion, attempts: attempt, elapsedMs: now() - started };
    }
    const baseWaitMs = attempt === 1 ? 1000 : Math.min(8000, 2500 * (2 ** (attempt - 2)));
    const waitMs = jitter ? Math.round(baseWaitMs * (0.85 + Math.random() * 0.3)) : baseWaitMs;
    if (now() - started + waitMs >= 120000) return { completion, attempts: attempt, elapsedMs: now() - started };
    await wait(waitMs, undefined, { signal });
  }
  return { completion, attempts, elapsedMs: now() - started };
}

export function modelAvailabilityHint(errorMessage, attempts) {
  return /Endpoint is unavailable|upstream.*unavailable/i.test(errorMessage || "")
    ? `供应商上游模型端点暂不可用，已尝试 ${attempts} 次（含自动重试）仍未恢复。请稍后重试，或先配置备用模型。`
    : "";
}
