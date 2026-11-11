import { describe, expect, it } from "bun:test";

import { agentUrl, WIRE } from "./client";
import {
	AGENT_FEATURES,
	AGENT_FEATURES_HEADER,
	AGENT_PATH,
	AGENT_SUBPROTOCOL,
	AGENT_VERSION,
	encodeMessage,
	LINK_CLOSE,
	MAX_LINK_ATTACHMENT_BYTES,
	MAX_LINK_MESSAGE_BYTES,
	MAX_LINK_NOTE_LENGTH,
	parseClientMessage,
	parseServerMessage,
	RESTART_RESUME_RETRY_MS,
	toolErrorSchema,
	usableCatalog,
} from "./protocol";

describe("Agent connection messages", () => {
	it("accepts each client message the protocol declares", () => {
		let messages = [
			{ type: "attach", version: AGENT_VERSION, document: "https://chopin.test/o/r/d" },
			{ type: "started", session: "s" },
			{ type: "tools", session: "s", turn: "t", names: ["read"] },
			{ type: "part", session: "s", turn: "t", part: { type: "text-delta", id: "a", delta: "hi" } },
			{
				type: "part",
				session: "s",
				turn: "t",
				part: {
					type: "tool-call",
					toolCallId: "c",
					toolName: "read",
					input: "{}",
					providerExecuted: true,
				},
			},
			{
				type: "part",
				session: "s",
				turn: "t",
				part: {
					type: "finish",
					finishReason: { unified: "stop" },
					totalUsage: { inputTokens: {}, outputTokens: {} },
				},
			},
			{
				type: "host-tool-call",
				session: "s",
				turn: "t",
				toolCallId: "c",
				toolName: "read_plan",
				input: "{}",
			},
			{ type: "turn-end", session: "s", turn: "t", status: "aborted" },
			{
				type: "input-request",
				request: "r",
				session: "s",
				workflowRunId: "run",
				input: {
					method: "questionnaire",
					params: {
						questions: [{
							header: "H",
							question: "Q?",
							options: [{ label: "A", description: "" }],
						}],
					},
				},
			},
			{ type: "input-cancel", request: "r" },
			{ type: "runs", session: "s", active: [], paused: ["run"], cards: [] },
			{ type: "control-result", request: "r", ok: false, message: "no" },
			{ type: "detach" },
		];
		for (let message of messages) {
			expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message } as never);
		}
	});

	it("accepts the block a question concerns without changing the connection version", () => {
		let message = {
			type: "input-request" as const,
			request: "r",
			session: "s",
			block: { index: 3, digest: `sha256:${"a".repeat(64)}` },
			input: { method: "confirm" as const, title: "Ship?", message: "Now." },
		};
		expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
		for (
			let block of [
				{ index: -1, digest: message.block.digest },
				{ index: 1.5, digest: message.block.digest },
				{ index: 3, digest: "sha256:short" },
				{ index: 3, digest: message.block.digest, extra: true },
			]
		) {
			expect(parseClientMessage(JSON.stringify({ ...message, block }))).toMatchObject({
				ok: false,
			});
		}
	});

	it("accepts optional stage parents and stopped stages without changing the connection version", () => {
		let message = {
			type: "runs" as const,
			session: "s",
			active: [],
			paused: [],
			cards: [{
				id: "run",
				name: "review",
				status: "stopped" as const,
				started: 1,
				updated: 2,
				waiting: 0,
				stages: [
					{ id: "parent", name: "parent", status: "stopped" as const },
					{ id: "child", name: "child", status: "running" as const, parentIds: ["parent"] },
				],
			}],
		};
		expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
		message.cards[0]!.stages[1]!.parentIds = Array(65).fill("parent");
		expect(parseClientMessage(JSON.stringify(message))).toMatchObject({ ok: false });
	});

	it("accepts a delta card with any number of stages, bounded only by the frame", () => {
		let stages = Array.from({ length: 500 }, (_, index) => ({
			id: `s${index}`,
			name: `stage ${index}`,
			status: "completed" as const,
			...(index ? { parentIds: [`s${index - 1}`] } : {}),
		}));
		let card = {
			id: "run",
			name: "review",
			status: "running" as const,
			started: 1,
			updated: 2,
			waiting: 0,
			stagesDelta: true as const,
			stages,
		};
		let message = {
			type: "runs" as const,
			session: "s",
			active: ["run"],
			paused: [],
			cards: [card],
		};
		expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
		let { stagesDelta: _, ...full } = card;
		expect(parseClientMessage(JSON.stringify({ ...message, cards: [full] }))).toMatchObject({
			ok: false,
			code: "malformed-message",
		});
		let short = { ...full, stages: stages.slice(0, 64) };
		expect(parseClientMessage(JSON.stringify({ ...message, cards: [short] }))).toMatchObject({
			ok: true,
		});
		for (let wrong of [{ ...card, earlierStages: 3 }, { ...card, stagesDelta: false }]) {
			expect(parseClientMessage(JSON.stringify({ ...message, cards: [wrong] }))).toMatchObject({
				ok: false,
				code: "malformed-message",
			});
		}
	});

	it("lets attached name the features a client asked for, without changing the version", () => {
		let attached = {
			type: "attached" as const,
			version: AGENT_VERSION,
			document: { id: "d", title: "T", repository: "o/r" },
			features: [AGENT_FEATURES.runStageDeltas],
		};
		expect(AGENT_FEATURES.runStageDeltas).toBe("run-stage-deltas");
		expect(AGENT_FEATURES.decisionOptionPreviews).toBe("decision-option-previews");
		expect(AGENT_FEATURES_HEADER).toBe("chopin-agent-features");
		expect(parseServerMessage(encodeMessage(attached))).toEqual({ ok: true, message: attached });
		expect(parseServerMessage(encodeMessage({ ...attached, features: ["has space"] })))
			.toMatchObject({ ok: false });
	});

	it("refuses text that is not JSON, binary frames, unknown types, and undeclared fields", () => {
		for (
			let raw of [
				"{",
				new Uint8Array([123, 125]),
				JSON.stringify({ type: "unknown" }),
				JSON.stringify({ type: "detach", extra: true }),
				JSON.stringify({ type: "started", session: "" }),
				JSON.stringify({ type: "started", session: "x".repeat(129) }),
				JSON.stringify({
					type: "part",
					session: "s",
					turn: "t",
					part: { type: "tool-call", toolCallId: "c", toolName: "read", input: "{}" },
				}),
				JSON.stringify({
					type: "part",
					session: "s",
					turn: "t",
					part: { type: "raw", rawValue: 1 },
				}),
			]
		) {
			expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: "malformed-message" });
		}
	});

	it("refuses a message over the size limit before parsing it", () => {
		let raw = JSON.stringify({ type: "detach", padding: "x".repeat(MAX_LINK_MESSAGE_BYTES) });
		expect(parseClientMessage(raw)).toMatchObject({ ok: false, code: "message-too-large" });
		let wide = JSON.stringify({
			type: "part",
			session: "s",
			turn: "t",
			part: { type: "text-delta", id: "a", delta: "é".repeat(MAX_LINK_MESSAGE_BYTES / 2) },
		});
		expect(wide.length).toBeLessThan(MAX_LINK_MESSAGE_BYTES);
		expect(parseClientMessage(wide)).toMatchObject({ ok: false, code: "message-too-large" });
		expect(encodeMessage({ type: "destroy", session: "s".repeat(MAX_LINK_MESSAGE_BYTES) }))
			.toBeUndefined();
	});

	it("round-trips server messages and states its version", () => {
		let message = {
			type: "turn" as const,
			session: "s",
			turn: "t",
			prompt: "plan",
			tools: [{ name: "read_plan", inputSchema: { type: "object" } }],
			responseFormat: { type: "json" as const, schema: { type: "object" } },
		};
		expect(parseServerMessage(encodeMessage(message))).toEqual({ ok: true, message });
		expect(parseServerMessage(encodeMessage({
			type: "attached",
			version: AGENT_VERSION,
			document: { id: "d", title: "T", repository: "o/r" },
		}))).toMatchObject({ ok: true });
	});

	it("carries a structured tool error in a failed tool-result and recognises its envelope", () => {
		let error = {
			error: {
				code: "no-repository-credential",
				kind: "NoRepositoryCredential",
				message: "No credential can read this repository.",
			},
		};
		let message = {
			type: "part" as const,
			session: "s",
			turn: "t",
			part: {
				type: "tool-result" as const,
				toolCallId: "c",
				toolName: "read",
				result: error,
				isError: true,
			},
		};
		expect(parseClientMessage(encodeMessage(message))).toEqual({ ok: true, message });
		expect(toolErrorSchema.parse(error)).toEqual(error);
		let plain = { error: { code: "stale-revision", message: "The document moved on." } };
		expect(toolErrorSchema.parse(plain)).toEqual(plain);
		let dotted = {
			error: { code: `E.clone_1-${"x".repeat(118)}`, kind: "Git.Timeout", message: "m" },
		};
		expect(toolErrorSchema.parse(dotted)).toEqual(dotted);
	});

	it("refuses a malformed tool error envelope but keeps any JSON as a tool result", () => {
		for (
			let malformed of [
				{ error: "plain text" },
				{ error: { message: "No code." } },
				{ error: { code: "", message: "Empty code." } },
				{ error: { code: "x".repeat(129), message: "Long code." } },
				{ error: { code: "c", message: "" } },
				{ error: { code: "c", message: "x".repeat(MAX_LINK_NOTE_LENGTH + 1) } },
				{ error: { code: "c", kind: 3, message: "Numeric kind." } },
				{ error: { code: "c", message: "Extra field.", stack: "at x" } },
				{ error: { code: "c", message: "Extra sibling." }, details: {} },
				{ error: { code: '{"token=abc":0}', message: "JSON code." } },
				{ error: { code: "c", kind: '{"token=abc":0}', message: "JSON kind." } },
				{ error: { code: "password: x", message: "Assignment code." } },
				{ error: { code: "c", kind: "token=abc", message: "Assignment kind." } },
				{ error: { code: "no credential", message: "Spaced code." } },
				{ error: { code: "c", kind: "Bearer x", message: "Spaced kind." } },
				{ error: { code: "-leading", message: "Leading punctuation." } },
				{ error: { code: "__proto__", message: "Leading underscore." } },
				{ error: { code: "line\u2028break", message: "Line separator." } },
			]
		) {
			expect(toolErrorSchema.safeParse(malformed).success).toBe(false);
			expect(parseClientMessage(JSON.stringify({
				type: "part",
				session: "s",
				turn: "t",
				part: { type: "tool-result", toolCallId: "c", toolName: "read", result: malformed },
			}))).toMatchObject({ ok: true });
		}
	});

	it("gives the wire-only client the same constants the server enforces", async () => {
		expect([AGENT_PATH, AGENT_SUBPROTOCOL]).toEqual(["/api/v1/agent", "chopin.agent.v1"]);
		expect(AGENT_SUBPROTOCOL).toBe(`chopin.agent.v${AGENT_VERSION}`);
		expect(WIRE).toEqual({
			path: AGENT_PATH,
			subprotocol: AGENT_SUBPROTOCOL,
			version: AGENT_VERSION,
			maxMessageBytes: MAX_LINK_MESSAGE_BYTES,
			maxNoteLength: MAX_LINK_NOTE_LENGTH,
			malformedClose: 4400,
			featuresHeader: AGENT_FEATURES_HEADER,
			runStageDeltas: AGENT_FEATURES.runStageDeltas,
			decisionOptionPreviews: AGENT_FEATURES.decisionOptionPreviews,
			resumableSessions: AGENT_FEATURES.resumableSessions,
			restartNotice: AGENT_FEATURES.restartNotice,
			capabilityCatalog: AGENT_FEATURES.capabilityCatalog,
			attachments: AGENT_FEATURES.attachments,
			restartResumeRetryMs: RESTART_RESUME_RETRY_MS,
		});
		expect(AGENT_FEATURES.restartNotice).toBe("restart-notice");
		expect(LINK_CLOSE.restarting).toBe(1012);
		let source = await Bun.file(new URL("./client.ts", import.meta.url)).text();
		let imports = [...source.matchAll(/^import\s+(type\s+)?/gm)];
		expect(imports.every(match => match[1])).toBe(true);
	});

	it("marks a refusal as worth retrying only when the server says so", () => {
		let transient = { type: "refused", code: "unavailable", message: "x", retry: true } as const;
		expect(parseServerMessage(encodeMessage(transient))).toEqual({ ok: true, message: transient });
		expect(parseServerMessage(JSON.stringify({ ...transient, retry: false }))).toMatchObject({
			ok: false,
		});
		expect(
			parseServerMessage(
				JSON.stringify({ type: "refused", code: "planner-attached", message: "x" }),
			),
		)
			.toMatchObject({ ok: true });
	});

	it("tells a client when a new process is expected, with a whole number of milliseconds", () => {
		let restarting = { type: "restarting", reconnectWithinMs: 10_000 } as const;
		expect(parseServerMessage(encodeMessage(restarting))).toEqual({
			ok: true,
			message: restarting,
		});
		for (let reconnectWithinMs of [-1, 1.5, "10", undefined]) {
			expect(parseServerMessage(JSON.stringify({ type: "restarting", reconnectWithinMs })))
				.toMatchObject({ ok: false });
		}
	});

	it("carries a client's acknowledgement of an answer by its request, and no more", () => {
		expect(parseClientMessage(encodeMessage({ type: "input-received", request: "r1" })))
			.toEqual({ ok: true, message: { type: "input-received", request: "r1" } });
		for (let message of [{ type: "input-received" }, { type: "input-received", request: "" }]) {
			expect(parseClientMessage(JSON.stringify(message))).toMatchObject({ ok: false });
		}
		expect(parseClientMessage(JSON.stringify({ type: "input-received", request: "r", extra: 1 })))
			.toMatchObject({ ok: false });
	});

	it("carries the sessions a resuming client holds, each with the requests it still waits on", () => {
		let held = [{ session: "s1", requests: ["r1", "r2"] }, { session: "s2", requests: [] }];
		expect(AGENT_FEATURES.resumableSessions).toBe("resumable-sessions");
		expect(parseClientMessage(encodeMessage({ type: "resume", sessions: held })))
			.toEqual({ ok: true, message: { type: "resume", sessions: held } });
		expect(parseServerMessage(encodeMessage({ type: "resumed", sessions: held })))
			.toEqual({ ok: true, message: { type: "resumed", sessions: held } });
		for (
			let sessions of [
				[{ session: "", requests: [] }],
				[{ session: "s", requests: [""] }],
				[{ session: "s", requests: Array.from({ length: 17 }, (_, i) => `r${i}`) }],
				[{ session: "s" }],
				[{ session: "s", requests: [], extra: true }],
			]
		) {
			expect(parseClientMessage(JSON.stringify({ type: "resume", sessions }))).toMatchObject({
				ok: false,
				code: "malformed-message",
			});
		}
	});

	it("derives the link URL from a Chopin origin", () => {
		expect(agentUrl("https://chopin.test/some/doc?x=1").href)
			.toBe("wss://chopin.test/api/v1/agent");
		expect(agentUrl("http://127.0.0.1:8787").href).toBe("ws://127.0.0.1:8787/api/v1/agent");
		expect(agentUrl("ws://127.0.0.1:1/custom").href).toBe("ws://127.0.0.1:1/custom");
		expect(() => agentUrl("ftp://chopin.test")).toThrow("http(s) or ws(s)");
	});
});

describe("The capability catalog", () => {
	let catalog = {
		models: {
			available: [
				{
					id: "acme/large:preview",
					name: "Large",
					provider: { id: "acme", name: "Acme" },
					description: "Slower and more careful.",
					thinkingLevels: ["off", "low", "high", "xhigh"],
				},
				{ id: "acme/small", name: "Small" },
			],
			default: { id: "acme/small" },
		},
		commands: [{ name: "release-notes", kind: "skill", description: "Draft release notes." }],
	};

	it("is a feature a client asks for, named as the documentation names it", () => {
		expect(AGENT_FEATURES.capabilityCatalog).toBe("capability-catalog");
		expect(WIRE.capabilityCatalog).toBe(AGENT_FEATURES.capabilityCatalog);
	});

	it("round-trips models, thinking levels and commands exactly as reported", () => {
		let message = { type: "capabilities" as const, catalog };
		let parsed = parseClientMessage(JSON.stringify(message));
		expect(parsed).toEqual({ ok: true, message });
		expect(encodeMessage(message)).toBe(JSON.stringify(message));
	});

	it("accepts an empty report and keeps the order, duplicates and spelling of what it names", () => {
		expect(parseClientMessage(JSON.stringify({ type: "capabilities", catalog: {} }))).toEqual({
			ok: true,
			message: { type: "capabilities", catalog: {} },
		});
		let odd = {
			models: {
				available: [
					{ id: "Z/b", name: "B", thinkingLevels: ["high", "off", "high"] },
					{ id: "Z/b", name: "B again" },
					{ id: "a/c", name: "C" },
				],
			},
		};
		let parsed = parseClientMessage(JSON.stringify({ type: "capabilities", catalog: odd }));
		expect(parsed).toEqual({ ok: true, message: { type: "capabilities", catalog: odd } });
	});

	it("accepts every string a client reports as it was written, however it is spelled or how long", () => {
		// The protocol does not say how a model, a level or a command is spelled, so none is refused.
		let odd = {
			models: {
				available: [
					{
						id: `acme/${"x".repeat(300)}`,
						name: "n".repeat(129),
						provider: { id: "p".repeat(200), name: "P".repeat(200) },
						description: "d".repeat(4_001),
						thinkingLevels: ["extra high", "deep thought", "\u4f4e", "x".repeat(300), "a:b=c", ""],
					},
					{ id: "", name: "" },
					{ id: 'with space \n and "quotes"', name: "Line\nbreak", thinkingLevels: [] },
				],
				default: { id: "y".repeat(300), thinkingLevel: "extra high" },
			},
			commands: [
				{ name: "n".repeat(200), description: "d".repeat(5_000), kind: "slash command" },
				{ name: "", kind: "" },
			],
		};
		let message = { type: "capabilities" as const, catalog: odd };
		expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
	});

	it("refuses only a value of the wrong type, which no client of this feature sends", () => {
		let refused = (value: unknown) =>
			parseClientMessage(JSON.stringify({ type: "capabilities", catalog: value })).ok;
		expect(refused({ models: { available: [{ id: 3, name: "x" }] } })).toBe(false);
		expect(refused({ models: { available: [{ id: "a" }] } })).toBe(false);
		expect(refused({ models: { available: "none" } })).toBe(false);
		expect(refused({ models: { available: [{ id: "a", name: "x", thinkingLevels: "high" }] } }))
			.toBe(false);
		expect(refused({ models: { available: [{ id: "a", name: "x", thinkingLevels: [3] }] } }))
			.toBe(false);
		expect(refused({ models: { available: [{ id: "a", name: "x", description: 3 }] } }))
			.toBe(false);
		expect(refused({ models: { available: [], default: { thinkingLevel: "low" } } })).toBe(false);
		expect(refused({ commands: [{ name: "x", kind: 3 }] })).toBe(false);
		expect(refused({ commands: [{ kind: "skill" }] })).toBe(false);
	});

	it("bounds a report only by the frame it travels in", () => {
		let big = { models: { available: [{ id: "a".repeat(MAX_LINK_MESSAGE_BYTES), name: "x" }] } };
		expect(parseClientMessage(JSON.stringify({ type: "capabilities", catalog: big })))
			.toMatchObject({
				ok: false,
				code: "message-too-large",
			});
	});

	it("takes as many models and commands as the frame holds, and a description as long as a skill's", () => {
		// Atomic's own models number 1,774 and its skills describe themselves in up to 925 characters.
		let large = {
			models: {
				available: Array.from({ length: 1_774 }, (_, index) => ({
					id: `provider/model-${index}`,
					name: `Model ${index}`,
					provider: { id: `provider-${index % 40}` },
					thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				})),
			},
			commands: Array.from({ length: 600 }, (_, index) => ({
				name: `skill-${index}`,
				kind: "skill",
				description: "d".repeat(925),
			})),
		};
		let parsed = parseClientMessage(JSON.stringify({ type: "capabilities", catalog: large }));
		expect(parsed).toEqual({ ok: true, message: { type: "capabilities", catalog: large } });
		let described = {
			models: { available: [{ id: "a", name: "x", description: "d".repeat(4_000) }] },
		};
		expect(parseClientMessage(JSON.stringify({ type: "capabilities", catalog: described })).ok)
			.toBe(true);
	});

	it("ignores a field it has no use for and keeps it as written, so a report can grow", () => {
		let grown = {
			models: {
				available: [{
					id: "a",
					name: "A",
					provider: { id: "p", homepage: "https://example.test" },
					price: { input: 1, output: 3 },
					thinkingLevels: ["low"],
				}],
				default: { id: "a", why: "cheapest" },
				recommended: ["a"],
			},
			commands: [{ name: "x", kind: "skill", aliases: ["y"] }],
			attachments: { images: true },
			mentions: [{ kind: "file" }],
		};
		let parsed = parseClientMessage(JSON.stringify({ type: "capabilities", catalog: grown }));
		expect(parsed).toEqual({ ok: true, message: { type: "capabilities", catalog: grown } });
		// Only the catalog is read this way: a message is still strict.
		expect(
			parseClientMessage(JSON.stringify({ type: "capabilities", catalog: {}, extra: 1 })).ok,
		)
			.toBe(false);
	});

	it("rides a turn as an optional thinking level beside the model, and old turns still parse", () => {
		let turn = {
			type: "turn" as const,
			session: "s",
			turn: "t",
			prompt: "p",
			tools: [],
		};
		expect(parseServerMessage(JSON.stringify(turn))).toEqual({ ok: true, message: turn });
		let chosen = { ...turn, model: "acme/large:preview", thinkingLevel: "high" };
		expect(parseServerMessage(JSON.stringify(chosen))).toEqual({ ok: true, message: chosen });
		// What the client reported is what comes back, however it is spelled or how long.
		let odd = { ...turn, model: `acme/${"m".repeat(5_000)}`, thinkingLevel: "very high" };
		expect(parseServerMessage(JSON.stringify(odd))).toEqual({ ok: true, message: odd });
		let long = {
			type: "part" as const,
			session: "s",
			turn: "t",
			part: {
				type: "stream-start" as const,
				modelId: odd.model,
			},
		};
		expect(parseClientMessage(JSON.stringify(long))).toEqual({ ok: true, message: long });
	});
});

describe("What Chopin can offer of a capability catalog", () => {
	it("skips a model whose id is empty and keeps every other entry, in the order given", () => {
		let reported = {
			models: {
				available: [
					{ id: "a", name: "A" },
					{ id: "", name: "Blank", thinkingLevels: ["low"] },
					{ id: "b", name: "B", description: "Second." },
					{ id: "a", name: "A again" },
				],
				default: { id: "b" },
			},
			commands: [{ name: "notes", kind: "skill" }],
		};
		let { catalog, skipped } = usableCatalog(reported);
		expect(catalog).toEqual({
			models: {
				available: [
					{ id: "a", name: "A" },
					{ id: "b", name: "B", description: "Second." },
					{ id: "a", name: "A again" },
				],
				default: { id: "b" },
			},
			commands: [{ name: "notes", kind: "skill" }],
		});
		expect(skipped).toEqual(['the model named "Blank" has no id']);
	});

	it("drops an empty level from a model's levels and keeps the others as written", () => {
		let { catalog, skipped } = usableCatalog({
			models: {
				available: [
					{ id: "a", name: "A", thinkingLevels: ["", "high", "extra high", "", "high"] },
					{ id: "b", name: "B", thinkingLevels: [""] },
					{ id: "c", name: "C", thinkingLevels: ["low"] },
				],
			},
		});
		// A model left with no level has no reasoning control, as one that listed none.
		expect(catalog.models?.available).toEqual([
			{ id: "a", name: "A", thinkingLevels: ["high", "extra high", "high"] },
			{ id: "b", name: "B", thinkingLevels: [] },
			{ id: "c", name: "C", thinkingLevels: ["low"] },
		]);
		expect(skipped).toEqual(["a lists an empty thinking level", "b lists an empty thinking level"]);
	});

	it("takes no default that names no model, and no empty level for a default", () => {
		let models = [{ id: "a", name: "A", thinkingLevels: ["low"] }];
		expect(usableCatalog({ models: { available: models, default: { id: "" } } })).toEqual({
			catalog: { models: { available: models } },
			skipped: ["the default model has no id"],
		});
		expect(
			usableCatalog({
				models: { available: models, default: { id: "a", thinkingLevel: "", why: "cheapest" } },
			}),
		).toEqual({
			catalog: { models: { available: models, default: { id: "a", why: "cheapest" } } },
			skipped: ["the default thinking level is empty"],
		});
	});

	it("leaves a catalog with nothing to skip exactly as the client wrote it, fields it does not use included", () => {
		let reported = {
			models: {
				available: [
					{
						id: "x".repeat(300),
						name: "",
						description: "",
						thinkingLevels: ["extra high", "\u4f4e"],
						price: { input: 1 },
					},
				],
				default: { id: "x".repeat(300), thinkingLevel: "extra high" },
				recommended: ["a"],
			},
			attachments: { images: true },
		};
		let { catalog, skipped } = usableCatalog(reported);
		expect(catalog).toEqual(reported);
		expect(skipped).toEqual([]);
		expect(usableCatalog({})).toEqual({ catalog: {}, skipped: [] });
		expect(usableCatalog({ commands: [{ name: "", kind: "" }] }).catalog).toEqual({
			commands: [{ name: "", kind: "" }],
		});
	});
});

describe("Images and files in a turn", () => {
	let turn = {
		type: "turn" as const,
		session: "s",
		turn: "t",
		prompt: "@ana: What is this?",
		tools: [],
	};
	let image = {
		id: "a1",
		name: "shot.png",
		kind: "image" as const,
		mediaType: "image/png",
		size: 7,
		data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64"),
	};
	let file = {
		id: "a2",
		name: "notes.md",
		kind: "file" as const,
		mediaType: "text/plain",
		size: 8,
		data: Buffer.from("# Notes\n").toString("base64"),
	};

	it("is a feature a client asks for, named as the documentation names it", () => {
		expect(AGENT_FEATURES.attachments).toBe("attachments");
		expect(WIRE.attachments).toBe(AGENT_FEATURES.attachments);
		// A turn's files fit inside one message with room for its prompt and tools.
		expect(MAX_LINK_ATTACHMENT_BYTES * 4 / 3).toBeLessThan(MAX_LINK_MESSAGE_BYTES);
	});

	it("round-trips a turn's files, in order, with their bytes as base64", () => {
		let message = { ...turn, attachments: [image, file] };
		let parsed = parseServerMessage(JSON.stringify(message));
		expect(parsed).toEqual({ ok: true, message });
		expect(encodeMessage(message)).toBe(JSON.stringify(message));
	});

	it("keeps the turn an older client sees exactly as it was: the field is optional and never sent empty", () => {
		expect(parseServerMessage(JSON.stringify(turn))).toEqual({ ok: true, message: turn });
		expect(encodeMessage(turn)).toBe(JSON.stringify(turn));
		expect(JSON.stringify(turn)).not.toContain("attachments");
	});

	it("refuses a file the protocol does not describe", () => {
		for (
			let bad of [
				{ ...file, kind: "document" },
				{ ...file, size: -1 },
				{ ...file, name: "" },
				{ ...file, extra: true },
				{ id: "a3", name: "x", kind: "file", mediaType: "text/plain", size: 0 },
			]
		) {
			expect(
				parseServerMessage(JSON.stringify({ ...turn, attachments: [bad] })),
				JSON.stringify(bad),
			)
				.toMatchObject({ ok: false });
		}
		expect(parseServerMessage(JSON.stringify({ ...turn, attachments: "shot.png" }))).toMatchObject({
			ok: false,
		});
	});

	it("takes what a model reads as a catalog reports it, and leaves the rest of the catalog alone", () => {
		let reported = {
			models: {
				available: [
					{ id: "acme/vision", name: "Vision", inputTypes: ["text", "image"] },
					{ id: "acme/text", name: "Text", inputTypes: ["text"] },
					{ id: "acme/unsaid", name: "Unsaid" },
				],
			},
		};
		let message = { type: "capabilities" as const, catalog: reported };
		expect(parseClientMessage(JSON.stringify(message))).toEqual({ ok: true, message });
		expect(usableCatalog(reported)).toEqual({ catalog: reported, skipped: [] });
		expect(
			parseClientMessage(JSON.stringify({
				type: "capabilities",
				catalog: { models: { available: [{ id: "a", name: "A", inputTypes: "image" }] } },
			})),
		).toMatchObject({ ok: false });
	});
});
