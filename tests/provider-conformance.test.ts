import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheCapabilitiesForProvider, createHarness, type HarnessModelMetadata, type HarnessProviderKind } from "../packages/runtime/src/index.ts";
import { EvaluationStore } from "../packages/evals/src/index.ts";
import { formatProviderSmokeDiagnostic, runLiveProviderSmokes } from "../apps/cli/src/live-smoke.ts";

test("providers declare the cache mode actually requested by the runtime", () => {
	assert.deepEqual(cacheCapabilitiesForProvider("anthropic").strategies, ["EXPLICIT_BREAKPOINT"]);
	assert.deepEqual(cacheCapabilitiesForProvider("openai-compatible").strategies, ["NO_PROVIDER_CACHE"]);
	assert.deepEqual(cacheCapabilitiesForProvider("openai").strategies, ["AUTO_PREFIX"]);
});

test("provider rate limits are retried within the bounded Pi request policy", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-provider-retry-"));
	let requests = 0;
	const statuses: number[] = [];
	const result = await createHarness().run({
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		objective: "Return a concise success response",
		provider: "retry-provider",
		modelId: "retry-model",
		providerConfiguration: { id: "retry-provider", name: "Retry Provider", kind: "openai-compatible", baseUrl: "https://retry.test/v1", apiKey: "test-key" },
		providerFetch: (async () => ++requests === 1
			? Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "0" } })
			: openAiStream("retry-model")) as typeof fetch,
		providerRetryLimit: 1,
		onProviderResponse: ({ status }) => statuses.push(status),
	});
	assert.equal(requests, 2);
	assert.deepEqual(statuses, [200]);
	assert.equal(result.verification.passed, true);
});

test("provider errors cannot persist the configured credential", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-provider-secret-"));
	const secret = "opaqueCredentialValue123456789";
	await createHarness().run({
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		objective: "Return a concise success response",
		provider: "secret-provider",
		modelId: "secret-model",
		providerConfiguration: { id: "secret-provider", name: "Secret Provider", kind: "openai-compatible", baseUrl: "https://secret.test/v1", apiKey: secret },
		providerFetch: (async () => Response.json({ error: { message: `credential ${secret}` } }, { status: 401 })) as typeof fetch,
		providerRetryLimit: 0,
	}).catch(() => undefined);
	const [runId] = await readdir(join(root, "runs"));
	assert.ok(runId);
	assert.doesNotMatch(await readFile(join(root, "runs", runId, "trace.jsonl"), "utf8"), new RegExp(secret));
});

test("env-only provider errors cannot persist the environment credential", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-provider-env-secret-"));
	const secret = "opaqueEnvCredentialValue123456789";
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = secret;
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	try {
		await createHarness().run({
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			objective: "Return a concise success response",
			runStore: store,
			provider: "openai",
			modelId: "gpt-5.4-mini",
			providerFetch: (async () => Response.json({ error: { api_key: secret } }, { status: 401 })) as typeof fetch,
			providerRetryLimit: 0,
		}).catch(() => undefined);
		const [runId] = await readdir(join(root, "runs"));
		assert.ok(runId);
		await store.backupTo(join(root, "backup.sqlite"));
		assert.doesNotMatch(await readFile(join(root, "runs", runId, "trace.jsonl"), "utf8"), new RegExp(secret));
		assert.doesNotMatch(JSON.stringify(store.runDetails(runId)), new RegExp(secret));
		assert.doesNotMatch(await readFile(join(root, "backup.sqlite"), "utf8"), new RegExp(secret));
	} finally {
		store.close();
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
	}
});

test("live provider smoke requires two opt-ins and never reports raw errors", async () => {
	const state = {
		directory: "/unused",
		configuration: { version: 1 as const, defaultProvider: "openai", providers: [{ id: "openai", name: "OpenAI", kind: "openai" as const, modelId: "gpt-5.4-mini", models: ["gpt-5.4-mini"], apiKeyEnv: "OPENAI_API_KEY" }] },
		credentials: { OPENAI_API_KEY: "test-private-credential-value" },
	};
	let calls = 0;
	await assert.rejects(() => runLiveProviderSmokes(state, { enabled: false, provider: "openai", runner: async () => { calls++; throw new Error("should not run"); } }), /CODETONOMY_LIVE_PROVIDER_SMOKE/);
	assert.equal(calls, 0);
	const [diagnostic] = await runLiveProviderSmokes(state, { enabled: true, provider: "openai", runner: async () => { throw new Error("Bearer test-private-credential-value"); } });
	assert.equal(diagnostic?.category, "network");
	assert.doesNotMatch(formatProviderSmokeDiagnostic(diagnostic!), /private|Bearer|sk-/i);
});

test("live provider smoke reports bounded retry and rate-limit diagnostics", async () => {
	const state = {
		directory: "/unused",
		configuration: { version: 1 as const, defaultProvider: "local", providers: [{ id: "local", name: "Local", kind: "openai-compatible" as const, baseUrl: "https://retry.test/v1", modelId: "retry-model", models: ["retry-model"], apiKeyEnv: "LOCAL_API_KEY" }] },
		credentials: { LOCAL_API_KEY: "test-key" },
	};
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (async () => ++requests === 1
		? Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "0" } })
		: openAiStream("retry-model")) as typeof fetch;
	try {
		const [diagnostic] = await runLiveProviderSmokes(state, { enabled: true, provider: "local" });
		assert.equal(diagnostic?.success, true);
		assert.deepEqual(diagnostic?.statuses, [429, 200]);
		assert.equal(diagnostic?.retries, 1);
		assert.equal(requests, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("live provider smoke leaves room for reasoning before final text", async () => {
	const state = {
		directory: "/unused",
		configuration: { version: 1 as const, defaultProvider: "opencode-go", providers: [{ id: "opencode-go", name: "OpenCode Go", kind: "opencode-go" as const, modelId: "deepseek-v4-flash", models: ["deepseek-v4-flash"], apiKeyEnv: "OPENCODE_API_KEY" }] },
		credentials: { OPENCODE_API_KEY: "test-key" },
	};
	let maximumOutputTokens: number | undefined;
	const [diagnostic] = await runLiveProviderSmokes(state, {
		enabled: true,
		provider: "opencode-go",
		runner: async (options) => {
			maximumOutputTokens = options.maxOutputTokens;
			return { output: "ok", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, verification: { passed: true, checks: [] } } as Awaited<ReturnType<ReturnType<typeof createHarness>["run"]>>;
		},
	});
	assert.equal(maximumOutputTokens, 256);
	assert.equal(diagnostic?.success, true);
});

test("live provider smoke classifies exhausted rate limits and retry-after-ms", async () => {
	const state = {
		directory: "/unused",
		configuration: { version: 1 as const, defaultProvider: "local", providers: [{ id: "local", name: "Local", kind: "openai-compatible" as const, baseUrl: "https://retry.test/v1", modelId: "retry-model", models: ["retry-model"], apiKeyEnv: "LOCAL_API_KEY" }] },
		credentials: { LOCAL_API_KEY: "test-key" },
	};
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (async () => { requests++; return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after-ms": "0" } }); }) as typeof fetch;
	try {
		const [diagnostic] = await runLiveProviderSmokes(state, { enabled: true, provider: "local" });
		assert.equal(diagnostic?.success, false);
		assert.equal(diagnostic?.category, "rate_limit");
		assert.deepEqual(diagnostic?.statuses, [429, 429]);
		assert.equal(diagnostic?.retryAfterCappedMs, 0);
		assert.equal(requests, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

const openAiStream = (model: string): Response => {
	const base = { id: "chat-1", object: "chat.completion.chunk", created: 1, model };
	return new Response([
		...(model.startsWith("deepseek-") ? [`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Checked the provider contract." }, finish_reason: null }] })}\n\n`] : []),
		`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Provider conformance passed." }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};

const anthropicStream = (): Response => new Response([
	`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-1", usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Provider conformance passed." } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
	`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })}\n\n`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

test("built-in OpenAI-compatible providers preserve endpoint and bearer-auth contracts", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-provider-contract-"));
	const dynamicGlm: HarnessModelMetadata = { id: "glm-5.3", name: "GLM 5.3", api: "openai-completions", reasoning: true, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 };
	const cases: Array<{ kind: HarnessProviderKind; model: string; endpoint: RegExp; metadata?: HarnessModelMetadata }> = [
		{ kind: "deepseek", model: "deepseek-v4-flash", endpoint: /^https:\/\/api\.deepseek\.com\// },
		{ kind: "openrouter", model: "ai21/jamba-large-1.7", endpoint: /^https:\/\/openrouter\.ai\/api\/v1\// },
		{ kind: "opencode", model: "kimi-k2.6", endpoint: /^https:\/\/opencode\.ai\/zen\/v1\// },
		{ kind: "opencode-go", model: "kimi-k2.6", endpoint: /^https:\/\/opencode\.ai\/zen\/go\/v1\// },
		{ kind: "opencode-go", model: "deepseek-v4-flash", endpoint: /^https:\/\/opencode\.ai\/zen\/go\/v1\// },
		{ kind: "opencode-go", model: "deepseek-v4-pro", endpoint: /^https:\/\/opencode\.ai\/zen\/go\/v1\// },
		{ kind: "opencode-go", model: "glm-5.3", endpoint: /^https:\/\/opencode\.ai\/zen\/go\/v1\//, metadata: dynamicGlm },
	];
	for (const item of cases) {
		let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
		const result = await createHarness().run({
			objective: "Return a concise provider confirmation",
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			provider: item.kind,
			modelId: item.model,
			providerConfiguration: { id: item.kind, name: item.kind, kind: item.kind, apiKey: "contract-key", ...(item.metadata ? { modelMetadata: item.metadata } : {}) },
			providerFetch: (async (input, init) => {
				request = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
				return openAiStream(item.model);
			}) as typeof fetch,
		});
		assert.equal(result.verification.passed, true, item.kind);
		assert.match(request!.url, item.endpoint);
		assert.equal(request!.headers.get("authorization"), "Bearer contract-key");
		assert.equal(request!.body.model, item.model);
		for (const tool of (request!.body.tools as Array<{ function?: { parameters?: { type?: string } }; input_schema?: { type?: string } }> | undefined) ?? []) {
			assert.equal(tool.function?.parameters?.type ?? tool.input_schema?.type, "object", `${item.kind}/${item.model} tool schema root`);
		}
		if (item.kind === "opencode-go" && item.model.startsWith("deepseek-")) assert.deepEqual(request!.body.thinking, { type: "enabled" });
		if (item.kind === "opencode-go" && item.model.startsWith("deepseek-")) {
			assert.equal(result.reasoning?.[0]?.text, "Checked the provider contract.");
			assert.equal(result.modelContext?.contextWindow, 1_000_000);
		}
		if (item.metadata) assert.equal(result.modelContext?.contextWindow, item.metadata.contextWindow);
	}
	await assert.rejects(() => createHarness().run({
		objective: "Return a concise provider confirmation",
		workspaceRoot: root,
		provider: "opencode-go",
		modelId: "unverified-live-model",
		providerConfiguration: { id: "opencode-go", name: "OpenCode Go", kind: "opencode-go", apiKey: "contract-key" },
	}), /Unknown opencode-go model/);
});

test("OpenCode Go DeepSeek disables thinking before forcing an action tool", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-opencode-go-action-"));
	await writeFile(join(root, "README.md"), "# Action fixture\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const request = requests.length;
		const base = { id: `opencode-go-action-${request}`, object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash" };
		const choices = request === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Inspect first.", tool_calls: [{ index: 0, id: "inspect-first", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: request === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Planning too long.", tool_calls: [{ index: 0, id: "truncated-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"unsafe\\n"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
				]
				: request === 3
					? [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-after-nudge", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					]
					: [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					];
		return new Response(`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "opencode-go",
		modelId: "deepseek-v4-flash",
		permissionMode: "auto",
		providerConfiguration: { id: "opencode-go", name: "OpenCode Go", kind: "opencode-go", apiKey: "contract-key" },
		providerFetch,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	assert.deepEqual(requests[0]?.thinking, { type: "enabled" });
	assert.deepEqual(requests[1]?.thinking, { type: "enabled" });
	assert.deepEqual(requests[2]?.thinking, { type: "disabled" });
	assert.equal(requests[2]?.tool_choice, "required");
	assert.doesNotMatch(JSON.stringify(requests[2]?.messages), /Planning too long/);
	assert.match(JSON.stringify(requests[2]?.messages), /next response must call/i);
});

test("Anthropic provider preserves Messages endpoint, image input, and versioned key headers", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-anthropic-contract-"));
	let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
	const result = await createHarness().run({
		objective: "Return a concise provider confirmation",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "anthropic",
		modelId: "claude-haiku-4-5",
		providerConfiguration: { id: "anthropic", name: "Anthropic", kind: "anthropic", apiKey: "contract-key" },
		images: [{ data: Buffer.from("image-fixture").toString("base64"), mimeType: "image/png" }],
		providerFetch: (async (input, init) => {
			request = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
			return anthropicStream();
		}) as typeof fetch,
	});
	assert.equal(result.verification.passed, true);
	assert.match(request!.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
	assert.equal(request!.headers.get("x-api-key"), "contract-key");
	assert.equal(request!.headers.get("anthropic-version"), "2023-06-01");
	assert.match(JSON.stringify(request!.body.messages), /image-fixture|aW1hZ2UtZml4dHVyZQ==/);
});

test("Google provider preserves Generative AI endpoint and API-key authentication", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-google-contract-"));
	const original = globalThis.fetch;
	let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
	globalThis.fetch = (async (input, init) => {
		request = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
		return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Provider conformance passed." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 4, totalTokenCount: 5 } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	try {
		const result = await createHarness().run({
			objective: "Return a concise provider confirmation",
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			provider: "google",
			modelId: "gemini-2.0-flash",
			providerConfiguration: { id: "google", name: "Google", kind: "google", apiKey: "contract-key" },
		});
		assert.equal(result.verification.passed, true);
		assert.match(request!.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.0-flash:streamGenerateContent/);
		assert.equal(request!.headers.get("x-goog-api-key"), "contract-key");
		assert.ok(Array.isArray(request!.body.contents));
	} finally {
		globalThis.fetch = original;
	}
});
