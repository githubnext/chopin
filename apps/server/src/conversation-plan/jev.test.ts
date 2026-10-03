import { expect, test } from "bun:test";
import { askJev, type JevRequest, validateJevResponse } from "./jev";

let request = {
	state: "Synthetic",
	questions: { flag: { type: "noul" as const, instructions: "Is this true?" } },
};
let response = () =>
	new Response(JSON.stringify({
		model: "jev-1.13.0",
		answers: { flag: { type: "noul", noul: 0.9 } },
		usage: { input_tokens: 1, output_tokens: 1 },
	}));

function delayedFetch(delayMs: number, calls: { count: number }) {
	return (_: string, init?: RequestInit): Promise<Response> => {
		calls.count++;
		return new Promise((resolve, reject) => {
			let signal = init?.signal;
			let timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve(response());
			}, delayMs);
			function onAbort() {
				clearTimeout(timer);
				reject(new Error("fetch aborted"));
			}
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	};
}

test("Jev accepts a response just beyond the former 20-second budget", async () => {
	let calls = { count: 0 };
	let result = await askJev(request, {
		apiKey: "test-only",
		fetch: delayedFetch(20_050, calls),
	});
	expect(result.answers.flag).toEqual({ type: "noul", noul: 0.9 });
	expect(calls.count).toBe(1);
}, 35_000);

test("Jev aborts after its configured budget without retrying", async () => {
	let calls = { count: 0 };
	await expect(askJev(request, {
		apiKey: "test-only",
		timeoutMs: 100,
		fetch: delayedFetch(500, calls),
	})).rejects.toThrow("Jev request timed out");
	expect(calls.count).toBe(1);
});

test("caller abort ends Jev before the timeout", async () => {
	let calls = { count: 0 };
	let controller = new AbortController();
	let pending = askJev(request, {
		apiKey: "test-only",
		timeoutMs: 1_000,
		signal: controller.signal,
		fetch: delayedFetch(500, calls),
	});
	controller.abort();
	await expect(pending).rejects.toThrow("Jev request aborted");
	expect(calls.count).toBe(1);
});

test("Jev timeout also bounds a stalled response body", async () => {
	let stream = new ReadableStream<Uint8Array>({ start() {} });
	await expect(askJev(request, {
		apiKey: "test-only",
		timeoutMs: 100,
		fetch: async () => new Response(stream),
	})).rejects.toThrow("Jev request timed out");
});

test("Jev normalizes a response body reader error", async () => {
	let stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new Error("secret response body"));
		},
	});
	await expect(askJev(request, {
		apiKey: "test-only",
		fetch: async () => new Response(stream),
	})).rejects.toThrow("Jev request failed");
});

test("Jev serializes one authenticated request and returns a validated result", async () => {
	let calls = 0;
	let result = await askJev(request, {
		apiKey: "test-only",
		model: "jev-fixture",
		fetch: async (url, init) => {
			calls++;
			expect(url).toBe("https://api.typesafe.ai/v1/systemone");
			expect(init?.method).toBe("POST");
			expect(init?.redirect).toBe("error");
			expect(init?.headers).toEqual({
				Authorization: "Bearer test-only",
				"Content-Type": "application/json",
			});
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect(JSON.parse(init?.body as string)).toEqual({ model: "jev-fixture", ...request });
			return response();
		},
	});
	expect(calls).toBe(1);
	expect(result.model).toBe("jev-1.13.0");
	expect(result.usage).toEqual({ input_tokens: 1, output_tokens: 1 });
	expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});

let typedRequest: JevRequest = {
	state: { text: "Synthetic" },
	questions: {
		flag: request.questions.flag,
		action: { type: "choice", instructions: "Choose", criteria: { save: "Save", skip: "Skip" } },
		strength: { type: "score", instructions: "Rate", criteria: ["Low", "High"] },
	},
};
function typedResponse() {
	return {
		model: "jev-fixture",
		usage: { input_tokens: 0, output_tokens: 1 },
		answers: {
			flag: { type: "noul", noul: 0.9 },
			action: {
				type: "choice",
				choice: "save",
				confidence: 0.8,
				probabilities: { save: 0.8, skip: 0.2 },
			},
			strength: {
				type: "score",
				score: 0.75,
				confidence: 0.9,
				legend: { "0": "Low", "1": "High" },
				probabilities: { "0": 0.25, "1": 0.75 },
			},
		},
	};
}

test("Jev validates noul, winning choice, and weighted score answers", () => {
	let value = typedResponse();
	expect<unknown>(validateJevResponse(value, typedRequest.questions)).toEqual({
		...value,
		latencyMs: 0,
	});
});

test("Jev rejects malformed answers instead of returning partial results", () => {
	let mutations: ((value: ReturnType<typeof typedResponse>) => void)[] = [
		(value) => {
			value.model = "";
		},
		(value) => {
			value.usage.input_tokens = -1;
		},
		(value) => {
			value.answers.flag.noul = Number.NaN;
		},
		(value) => {
			Object.assign(value.answers.flag, { extra: true });
		},
		(value) => {
			Object.assign(value.answers, { extra: { type: "noul", noul: 0.5 } });
		},
		(value) => {
			value.answers.flag.type = "choice";
		},
		(value) => {
			value.answers.action.choice = "skip";
		},
		(value) => {
			value.answers.action.confidence = 1.1;
		},
		(value) => {
			value.answers.action.probabilities.save = 0.1;
		},
		(value) => {
			Object.assign(value.answers.action.probabilities, { other: 0 });
		},
		(value) => {
			value.answers.strength.legend["0"] = "Wrong";
		},
		(value) => {
			value.answers.strength.score = 0.1;
		},
	];
	for (let mutate of mutations) {
		let value = typedResponse();
		mutate(value);
		expect(() => validateJevResponse(value, typedRequest.questions)).toThrow("invalid Jev");
	}
});

test("Jev rejects request bounds before invoking transport", async () => {
	let calls = 0;
	let options = {
		apiKey: "test-only",
		fetch: async () => {
			calls++;
			return response();
		},
	};
	let invalid: JevRequest[] = [
		{ ...request, questions: {} },
		{ ...request, state: "x".repeat(24001) },
		{
			state: "",
			questions: Object.fromEntries(
				["first", "second"].map(id => [id, {
					type: "choice",
					instructions: "Choose",
					criteria: Object.fromEntries(
						Array.from({ length: 255 }, (_, index) => [String(index), "😀".repeat(250)]),
					),
				}]),
			) as JevRequest["questions"],
		},
		{ ...request, questions: { "invalid id": request.questions.flag } },
		{ ...request, questions: { flag: { ...request.questions.flag, instructions: "" } } },
		{
			state: "",
			questions: { action: { type: "choice", instructions: "Choose", criteria: { only: "One" } } },
		},
		{
			state: "",
			questions: { strength: { type: "score", instructions: "Rate", criteria: ["One"] } },
		},
	];
	for (let value of invalid) await expect(askJev(value, options)).rejects.toThrow("invalid Jev");
	await expect(askJev(request, { ...options, model: "invalid/model" })).rejects.toThrow(
		"invalid Jev model selection",
	);
	await expect(askJev(request, { ...options, timeoutMs: 99 })).rejects.toThrow(
		"invalid Jev timeout",
	);
	expect(calls).toBe(0);
});

test("Jev rejects oversized and malformed response bodies", async () => {
	for (
		let value of [
			new Response("{}", { headers: { "content-length": "262145" } }),
			new Response("x".repeat(262145)),
		]
	) {
		await expect(askJev(request, {
			apiKey: "test-only",
			fetch: async () => value,
		})).rejects.toThrow("Jev response is too large");
	}
	await expect(askJev(request, {
		apiKey: "test-only",
		fetch: async () => new Response("{broken"),
	})).rejects.toThrow("invalid Jev JSON");
});
