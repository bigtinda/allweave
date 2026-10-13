import type { ProviderHeaders, ProviderStreams, StreamOptions } from "../types.ts";

const OPENCODE_SESSION_HEADER = "x-opencode-session";
const OPENCODE_SESSION_PREFIX = "ses_";
const OPENCODE_SESSION_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let sessionCounter = 0;
const generatedSessionIds = new Map<string, string>();

export function isOpenCodeSessionId(sessionId: unknown): sessionId is string {
	return typeof sessionId === "string" && OPENCODE_SESSION_ID.test(sessionId);
}

/** Creates the descending session identifier format used by OpenCode. */
export function createOpenCodeSessionId(): string {
	const timestamp = Date.now();
	if (timestamp !== lastTimestamp) {
		lastTimestamp = timestamp;
		sessionCounter = 0;
	}
	const counter = ++sessionCounter;
	let value = BigInt(timestamp) * 0x1000n + BigInt(counter);
	value = ~value;
	const timestampBytes = new Uint8Array(6);
	for (let index = 0; index < timestampBytes.length; index++) {
		timestampBytes[index] = Number((value >> BigInt(40 - index * 8)) & 0xffn);
	}
	const randomBytes = new Uint8Array(14);
	globalThis.crypto.getRandomValues(randomBytes);
	const timestampPart = Array.from(timestampBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const randomPart = Array.from(randomBytes, (byte) => base62[byte % base62.length]).join("");
	return `${OPENCODE_SESSION_PREFIX}${timestampPart}${randomPart}`;
}

function toOpenCodeSessionId(sessionId: string): string {
	if (isOpenCodeSessionId(sessionId)) return sessionId;
	const existing = generatedSessionIds.get(sessionId);
	if (existing) return existing;
	const generated = createOpenCodeSessionId();
	if (generatedSessionIds.size >= 1024) {
		const oldest = generatedSessionIds.keys().next().value;
		if (oldest !== undefined) generatedSessionIds.delete(oldest);
	}
	generatedSessionIds.set(sessionId, generated);
	return generated;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	const expected = name.toLowerCase();
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

function withSessionHeader<TOptions extends StreamOptions>(options: TOptions | undefined): TOptions | undefined {
	if (!options?.sessionId || hasHeader(options.headers, OPENCODE_SESSION_HEADER)) return options;
	return {
		...options,
		headers: { ...options.headers, [OPENCODE_SESSION_HEADER]: toOpenCodeSessionId(options.sessionId) },
	};
}

/** Adds OpenCode's required per-conversation routing header before API dispatch. */
export function withOpenCodeSessionHeader(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => streams.stream(model, context, withSessionHeader(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, withSessionHeader(options)),
	};
}
