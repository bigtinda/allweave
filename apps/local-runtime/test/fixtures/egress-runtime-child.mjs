import { appendFileSync, readFileSync } from "node:fs";
import { startModelProviderServer } from "../../src/model-provider-server.mjs";

const providerLogPath = process.env.FIXTURE_PROVIDER_LOG;
const providerModePath = process.env.FIXTURE_PROVIDER_MODE;
globalThis.fetch = async (input, init = {}) => {
	let requestIndex = 1;
	try { requestIndex = readFileSync(providerLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean).length + 1; } catch { }
	appendFileSync(providerLogPath, `${JSON.stringify({ url: String(input), method: init.method ?? "GET" })}\n`, "utf8");
	let mode = "reject";
	try { mode = readFileSync(providerModePath, "utf8").trim() || mode; } catch { }
	if (mode === "chat-success" || mode === "chat-attachment") {
        if (mode === "chat-attachment" && !String(init.body).includes("fixture attachment text")) return new Response("attachment missing", { status: 400 });
        const chunk = { id: "chatcmpl-fixture-chat", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
	if (mode === "agent-read-audit" || (mode === "agent-write-then-hold" && requestIndex === 1)) {
		const toolCall = (name, args) => ({
			id: `fixture-call-${requestIndex}`,
			type: "function",
			function: { name, arguments: JSON.stringify(args) },
		});
		const tool = mode === "agent-write-then-hold"
			? toolCall("create_project_file", { path: "partial.md", content: "由假 Agent 在中断前写出的部分产物" })
			: requestIndex === 1
				? toolCall("read_project_file", { path: "01_需求文档/brief.md" })
				: requestIndex === 2
					? toolCall("create_project_file", { path: "audit-result.md", content: "由隔离 Agent 依据项目文件生成" })
					: null;
		const delta = tool
			? { role: "assistant", tool_calls: [{ index: 0, ...tool }] }
			: { role: "assistant", content: "已读取授权项目资料并创建审核文件。" };
		const finishReason = tool ? "tool_calls" : "stop";
		const events = [
			{ id: `chatcmpl-fixture-${requestIndex}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] },
			"[DONE]",
		];
		return new Response(`${events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")}`, {
			status: 200,
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
		});
	}
	if (mode === "hold" || (mode === "agent-write-then-hold" && requestIndex >= 2)) {
		return new Promise((resolve, reject) => {
			const signal = init.signal;
			const timeout = setTimeout(() => resolve(new Response("fixture timeout", { status: 408 })), 20_000);
			const abort = () => {
				clearTimeout(timeout);
				reject(new DOMException("Fixture provider request aborted", "AbortError"));
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
	}
	return new Response(JSON.stringify({ error: { message: "Fixture provider intentionally rejects test requests", api_key: "sk_fixture_secret_123456789" } }), {
		status: 401,
		headers: { "content-type": "application/json" },
	});
};

const stop = await startModelProviderServer();
let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	await stop();
	process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
