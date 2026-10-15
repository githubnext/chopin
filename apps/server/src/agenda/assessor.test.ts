import { expect, it, spyOn } from "bun:test";
import { ATOMIC_RESULT_TOOL_NAME, createAtomicAdapter } from "../harness/atomic/adapter";
import { harnesses, shutdownHarnesses } from "../harness/harnesses";
import { startStubModelServer } from "../harness/atomic/model-stub";
import { createAgendaAssessor } from "./assessor";
import { QUESTIONS, SCOPE } from "./test-support";
import type { HarnessV1PromptTurnOptions, HarnessV1StartOptions } from "@ai-sdk/harness";
import type { AgendaAssessmentInput, AgendaCredential } from "./assessor";
import type { Assessment } from "./domain";

let input: AgendaAssessmentInput = {
	scope: SCOPE,
	questions: [{ ...QUESTIONS[0]!, id: "question-one" }],
	document: "# Document\n\nPRIVATE_DOCUMENT_MARKER",
	evidence: ["PRIVATE_EVIDENCE_MARKER"],
};
let assessment: Assessment = {
	decision: "investigate",
	questionId: "question-one",
	reason: "Public evidence would help clarify decision states.",
};

function credential(): AgendaCredential {
	return {
		owner: {
			userId: "member",
			userHandle: "member",
			sessionId: "session",
			generation: 1,
			credentialRevision: 1,
		},
		token: () => "test-token",
		signal: new AbortController().signal,
		authorize: async () => true,
		release: () => {},
	};
}

async function withAssessor(
	check: (context: {
		assessor: ReturnType<typeof createAgendaAssessor>;
		stub: ReturnType<typeof startStubModelServer>;
		began: Promise<void>;
		starts: HarnessV1StartOptions[];
		turns: HarnessV1PromptTurnOptions[];
		destroys: () => number;
		closed: Promise<void>;
		builtinFiltering: HarnessV1StartOptions["builtinToolFiltering"];
		resultTool: string;
	}) => Promise<void>,
) {
	let began = Promise.withResolvers<void>();
	let closed = Promise.withResolvers<void>();
	let resultTool = ATOMIC_RESULT_TOOL_NAME;
	let stub = startStubModelServer(prompt => {
		let value = JSON.parse(prompt) as { publicScope?: string; document?: string };
		if (value.document === "Hold model") {
			began.resolve();
			return { kind: "hold" };
		}
		return {
			kind: "tool",
			name: resultTool,
			arguments: JSON.stringify(value.publicScope ? { questions: QUESTIONS } : assessment),
		};
	});
	let providers = {
		stub: {
			baseUrl: stub.baseUrl,
			apiKey: "stub-key",
			api: "openai-completions" as const,
			models: [{
				id: "stub-model",
				name: "Stub Model",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4_096,
			}],
		},
	};
	let adapter = createAtomicAdapter({ auth: "ai-gateway", model: "stub/stub-model", providers });
	let starts: HarnessV1StartOptions[] = [];
	let turns: HarnessV1PromptTurnOptions[] = [];
	let destroys = 0;
	let keys = ["HARNESS", "HARNESS_AUTH", "HARNESS_EXTENSIONS", "SERVER_HOST"];
	let previous = keys.map(key => process.env[key]);
	await shutdownHarnesses();
	let factory = spyOn(harnesses, "atomic").mockImplementation(() => ({
		...adapter,
		async doStart(options) {
			starts.push(options);
			let session = await adapter.doStart(options);
			return {
				...session,
				doPromptTurn(options) {
					turns.push(options);
					return session.doPromptTurn(options);
				},
				async doDestroy() {
					await session.doDestroy();
					destroys++;
					closed.resolve();
				},
			};
		},
	}));
	try {
		process.env.HARNESS = "atomic";
		process.env.HARNESS_AUTH = "ai-gateway";
		process.env.HARNESS_EXTENSIONS = "";
		process.env.SERVER_HOST = "127.0.0.1";
		await check({
			assessor: createAgendaAssessor("stub/stub-model"),
			stub,
			began: began.promise,
			starts,
			turns,
			destroys: () => destroys,
			closed: closed.promise,
			builtinFiltering: Object.keys(adapter.builtinTools).length === 0
				? undefined
				: { mode: "allow", toolNames: [] },
			resultTool,
		});
	} finally {
		await shutdownHarnesses();
		factory.mockRestore();
		for (let [index, key] of keys.entries()) {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		}
		stub.stop();
	}
}

it("Atomic agenda workers return structured candidates and assessments without ambient tools", async () => {
	await withAssessor(async context => {
		let signal = new AbortController().signal;
		expect(await context.assessor.generate(SCOPE, credential(), signal)).toEqual(QUESTIONS);
		expect(await context.assessor.assess(input, credential(), signal)).toEqual(assessment);
		expect(context.stub.requests).toHaveLength(2);
		expect(JSON.parse(context.stub.requests[0]!.prompt)).toEqual({ publicScope: SCOPE });
		expect(JSON.parse(context.stub.requests[1]!.prompt)).toEqual(input);
		for (let request of context.stub.requests) {
			expect(request.toolNames).toEqual([context.resultTool]);
		}
		for (let turn of context.turns) {
			expect(turn.tools).toEqual([]);
			expect(turn.responseFormat?.type).toBe("json");
		}
		for (let start of context.starts) {
			expect(start.builtinToolFiltering).toEqual(context.builtinFiltering);
		}
		expect(context.destroys()).toBe(2);
	});
});

it("Atomic agenda assessment aborts and closes its isolated worker session", async () => {
	await withAssessor(async context => {
		let controller = new AbortController();
		let result = context.assessor.assess(
			{ ...input, document: "Hold model" },
			credential(),
			controller.signal,
		);
		let settled = result.then(value => ({ value }), error => ({ error }));
		await context.began;
		controller.abort();
		expect((await settled as { error: Error }).error.message).toBe("agenda model interrupted");
		await context.closed;
		expect(context.stub.requests).toHaveLength(1);
		expect(context.destroys()).toBe(1);
	});
});
