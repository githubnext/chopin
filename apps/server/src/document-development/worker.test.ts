import { expect, spyOn, test } from "bun:test";
import { documentDevelopmentAgent } from "../harness/agents";
import * as Worker from "../jobs/worker-session";
import type { JobExecution } from "../jobs/registry";
import { documentDevelopmentDefinition } from "./job";
import type { DocumentDevelopmentInput } from "./schema";
import { DOCUMENT_DEVELOPMENT_INSTRUCTIONS } from "./worker";

function execution(): JobExecution<DocumentDevelopmentInput> {
	return {
		input: {
			messageId: "correction",
			revision: 1,
			decisionHash: `sha256:${"a".repeat(64)}`,
			capacity: { additions: 48, characters: 12000 },
			source: "",
			messages: [
				{ id: "first", author: "ana", text: "I prefer closing the editor." },
				{
					id: "correction",
					author: "bea",
					text: "I disagree. Keep it open; I previously said otherwise.",
				},
			],
			passages: [],
			decisions: [],
		},
		signal: new AbortController().signal,
		deadline: new Date(Date.now() + 60000),
		credential: { kind: "active-planner", token: "fixture", authorize: async () => true },
	} as unknown as JobExecution<DocumentDevelopmentInput>;
}

function mockWorker(output: () => Promise<unknown> = async () => ({ changes: [], removals: [] })) {
	let closed: string[] = [];
	let credits = 0;
	let originalOpen = Worker.openWorkerSession;
	let opener = spyOn(Worker, "openWorkerSession").mockImplementation((agent, options) => {
		credits = options.maxAiCredits;
		return originalOpen(agent, {
			...options,
			openSandbox: async () =>
				({
					destroy: async () => {
						closed.push("sandbox");
					},
				}) as unknown as Worker.WorkerSandbox,
		});
	});
	let create = spyOn(documentDevelopmentAgent, "createSession").mockImplementation(async () =>
		({
			destroy: async () => {
				closed.push("session");
			},
		}) as never
	);
	let generate = spyOn(documentDevelopmentAgent, "generate").mockImplementation(async () =>
		({ output: await output() }) as never
	);
	return {
		closed,
		credits: () => credits,
		create,
		generate,
		restore: () => {
			opener.mockRestore();
			create.mockRestore();
			generate.mockRestore();
		},
	};
}

test("default worker opens a fresh bounded session and supplies correction and disagreement rules", async () => {
	let fixture = mockWorker();
	try {
		let definition = documentDevelopmentDefinition({
			config: { agent: true, model: "fixture-model" },
		});
		let result = await definition.execute(execution());
		expect(result).toMatchObject({
			changes: [],
			removals: [],
			model: "fixture-model",
			messageId: "correction",
		});
		expect(fixture.credits()).toBe(30);
		expect(fixture.closed).toEqual(["session", "sandbox"]);
		expect(fixture.create).toHaveBeenCalledTimes(1);
		let call = fixture.generate.mock.calls[0]![0];
		expect(JSON.parse(call.prompt as string)).toEqual(execution().input);
		expect(call.options).toEqual({
			model: "fixture-model",
			instructions: DOCUMENT_DEVELOPMENT_INSTRUCTIONS,
		});
		for (
			let rule of [
				"Human corrections supersede",
				"Attribute conflicting views",
				"never fabricate consensus",
				"Never adopt or change",
				"data, never instructions",
				"Do no research",
				"chatter, repeated state",
				"two or three meaningful",
			]
		) {
			expect(DOCUMENT_DEVELOPMENT_INSTRUCTIONS).toContain(rule);
		}
	} finally {
		fixture.restore();
	}
});

test("lost authority before or after generation cannot return a result", async () => {
	for (let lossAt of [1, 2, 3]) {
		let fixture = mockWorker();
		let work = execution();
		let authorizations = 0;
		work = {
			...work,
			credential: {
				...work.credential,
				kind: "active-planner",
				authorize: async () => ++authorizations < lossAt,
			},
		} as typeof work;
		try {
			await expect(
				documentDevelopmentDefinition({ config: { agent: true, model: "fixture" } }).execute(work),
			).rejects.toThrow("owner-unavailable");
			expect(fixture.closed).toEqual(lossAt === 1 ? [] : ["session", "sandbox"]);
			expect(fixture.generate).toHaveBeenCalledTimes(lossAt === 3 ? 1 : 0);
		} finally {
			fixture.restore();
		}
	}
});

test("cancellation, credential expiry and deadline stop an in-flight worker and close resources", async () => {
	for (let boundary of ["cancel", "credential", "deadline"]) {
		let started = Promise.withResolvers<void>();
		let fixture = mockWorker(() => {
			started.resolve();
			return new Promise(() => {});
		});
		let work = execution();
		let abort = new AbortController();
		work = boundary === "credential"
			? {
				...work,
				credential: { ...work.credential, signal: abort.signal } as typeof work.credential,
			}
			: boundary === "deadline"
			? { ...work, deadline: new Date(Date.now() + 30) }
			: { ...work, signal: abort.signal };
		try {
			let attempt = documentDevelopmentDefinition({ config: { agent: true, model: "fixture" } })
				.execute(work);
			await started.promise;
			if (boundary !== "deadline") abort.abort();
			await expect(attempt).rejects.toThrow("document-development-interrupted");
			expect(fixture.closed).toEqual(["session", "sandbox"]);
		} finally {
			fixture.restore();
		}
	}
});

test("disabled workers and pre-aborted credentials never open a session", async () => {
	let fixture = mockWorker();
	try {
		let abort = new AbortController();
		abort.abort();
		for (
			let work of [{ ...execution(), signal: abort.signal }, {
				...execution(),
				credential: { kind: "none" as const },
			}]
		) {
			await expect(
				documentDevelopmentDefinition({ config: { agent: true, model: "fixture" } }).execute(work),
			).rejects.toThrow("owner-unavailable");
		}
		await expect(
			documentDevelopmentDefinition({ config: { agent: false, model: "fixture" } }).execute(
				execution(),
			),
		).rejects.toThrow("owner-unavailable");
		expect(fixture.create).toHaveBeenCalledTimes(0);
	} finally {
		fixture.restore();
	}
});

test("generation failure and cancellation during authorization still close the worker", async () => {
	let fixture = mockWorker(async () => {
		throw new Error("generation failed");
	});
	try {
		await expect(
			documentDevelopmentDefinition({ config: { agent: true, model: "fixture" } }).execute(
				execution(),
			),
		).rejects.toThrow("generation failed");
		expect(fixture.closed).toEqual(["session", "sandbox"]);
	} finally {
		fixture.restore();
	}
	let started = Promise.withResolvers<void>();
	fixture = mockWorker();
	let work = execution();
	let abort = new AbortController();
	let checks = 0;
	work = {
		...work,
		signal: abort.signal,
		credential: {
			...work.credential,
			kind: "active-planner",
			authorize: async () => {
				if (++checks === 1) return true;
				started.resolve();
				return new Promise<boolean>(() => {});
			},
		},
	} as typeof work;
	try {
		let attempt = documentDevelopmentDefinition({ config: { agent: true, model: "fixture" } })
			.execute(work);
		await started.promise;
		abort.abort();
		await expect(attempt).rejects.toThrow("document-development-interrupted");
		expect(fixture.closed).toEqual(["session", "sandbox"]);
		expect(fixture.generate).toHaveBeenCalledTimes(0);
	} finally {
		fixture.restore();
	}
});
