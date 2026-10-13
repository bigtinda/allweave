import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import { createOpenCodeSessionId, withOpenCodeSessionHeader } from "../src/providers/opencode-headers.ts";
import type { Api, Model, ProviderStreams, StreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<Api> = {
	id: "test-model",
	name: "Test model",
	api: "test-api",
	provider: "opencode",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function completedStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = fauxAssistantMessage("ok");
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

function recordingStreams(capture: (options: StreamOptions | undefined) => void): ProviderStreams {
	return {
		stream: (_model, _context, options) => {
			capture(options);
			return completedStream();
		},
		streamSimple: (_model, _context, options) => {
			capture(options);
			return completedStream();
		},
	};
}

describe("OpenCode provider headers", () => {
	it("uses OpenCode Go stream capabilities for its OpenAI-compatible models", () => {
		const models = opencodeGoProvider()
			.getModels()
			.filter((candidate) => candidate.api === "openai-completions");

		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model).toHaveProperty("compat.supportsUsageInStreaming", false);
		}
	});

	// Regression test for https://github.com/earendil-works/pi/issues/9326
	it.each(["stream", "streamSimple"] as const)(
		"maps sessionId for %s requests even without cache retention",
		(method) => {
			let captured: StreamOptions | undefined;
			const sessionId = createOpenCodeSessionId();
			const streams = withOpenCodeSessionHeader(
				recordingStreams((options) => {
					captured = options;
				}),
			);

			streams[method](model, context, { sessionId, cacheRetention: "none" });

			expect(captured?.headers).toEqual({ "x-opencode-session": sessionId });
		},
	);

	it("maps a stable task session key to a stable OpenCode session ID", () => {
		const captured: string[] = [];
		const streams = withOpenCodeSessionHeader(
			recordingStreams((options) => {
				captured.push(String(options?.headers?.["x-opencode-session"]));
			}),
		);

		streams.streamSimple(model, context, { sessionId: "meeting:project-1:meeting-1" });
		streams.streamSimple(model, context, { sessionId: "meeting:project-1:meeting-1" });

		expect(captured[0]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		expect(captured[1]).toBe(captured[0]);
	});

	it.each([
		{ headers: { "X-OpenCode-Session": "caller-value" }, expected: { "X-OpenCode-Session": "caller-value" } },
		{ headers: { "X-OpenCode-Session": null }, expected: { "X-OpenCode-Session": null } },
	] as const)("preserves a case-insensitive caller override", ({ headers, expected }) => {
		let captured: StreamOptions | undefined;
		const streams = withOpenCodeSessionHeader(
			recordingStreams((options) => {
				captured = options;
			}),
		);

		streams.streamSimple(model, context, { sessionId: "generated-value", headers });

		expect(captured?.headers).toEqual(expected);
	});

	it("does not fabricate a session header when sessionId is absent", () => {
		let captured: StreamOptions | undefined;
		const streams = withOpenCodeSessionHeader(
			recordingStreams((options) => {
				captured = options;
			}),
		);

		streams.streamSimple(model, context, { headers: { "x-custom": "value" } });

		expect(captured?.headers).toEqual({ "x-custom": "value" });
	});
});
