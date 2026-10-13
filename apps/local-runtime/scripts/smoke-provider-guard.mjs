import assert from "node:assert/strict";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

let guardCalls = 0;
let fetchCalls = 0;
const credentials = new Map();
const credentialStore = {
	async read(providerId) {
		return credentials.get(providerId);
	},
	async list() {
		return [...credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	},
	async modify(providerId, update) {
		const next = await update(credentials.get(providerId));
		if (next !== undefined) credentials.set(providerId, next);
		return credentials.get(providerId);
	},
	async delete(providerId) {
		credentials.delete(providerId);
	},
};

const runtime = await ModelRuntime.create({
	credentials: credentialStore,
	modelsPath: null,
	allowModelNetwork: false,
	refreshOnCreate: false,
	providerRequestGuard: () => {
		guardCalls += 1;
		throw new Error("blocked by local egress fixture");
	},
});
await runtime.setRuntimeApiKey("openai", "fixture-only-not-a-credential");

const model = runtime.getModels("openai").find((candidate) => candidate.api === "openai-responses");
assert.ok(model, "an OpenAI Responses model must be present in the local catalog");

const cwd = process.cwd();
const resourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => "Local provider guard smoke fixture.",
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => {},
	reload: async () => {},
};
const { session } = await createAgentSession({
	cwd,
	model,
	thinkingLevel: "off",
	modelRuntime: runtime,
	resourceLoader,
	noTools: "all",
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
});
assert.deepEqual(session.getActiveToolNames(), [], "the smoke session must expose no built-in tools");
assert.deepEqual(session.getCallableToolNames(), [], "the smoke session must have no callable tools");

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	fetchCalls += 1;
	throw new Error("network fetch reached despite the guard");
};

try {
	await session.prompt("This request must be blocked before network fetch.");
} catch {
	// The session reports a rejected provider request through its error path.
} finally {
	session.dispose();
	globalThis.fetch = originalFetch;
}

assert.ok(guardCalls >= 1, "the final provider payload must reach the guard");
assert.equal(fetchCalls, 0, "a rejected payload must not reach fetch");
console.log("AgentSession blocked the OpenAI Responses request before fetch and disposed cleanly");
