// Browser history contains plain text, whereas Pi expects complete assistant
// transcript records. Missing usage crashes context estimation before HTTP.
export function toModelMessages(messages, model) {
  return messages.map((message) => message.role === "user"
    ? { role: "user", content: message.content, timestamp: message.timestamp ?? Date.now() }
    : {
      role: "assistant", content: [{ type: "text", text: message.content }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop",
      timestamp: message.timestamp ?? Date.now(),
      // No usage was retained with the historical text. Zero tells Pi to
      // estimate from content; these are not reported provider token counts.
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
}
