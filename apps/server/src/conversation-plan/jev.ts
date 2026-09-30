/** Bounded TypeSafe SystemOne transport. Only validated answers leave this boundary. */
export type JevQuestion =
	| { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
	| {
		type: "score";
		score: number;
		confidence: number;
		legend: Record<string, string>;
		probabilities: Record<string, number>;
	};

export type JevRequest = {
	state: object | string | unknown[];
	questions: Record<string, JevQuestion>;
};
export type JevResult = {
	model: string;
	answers: Record<string, JevAnswer>;
	usage: { input_tokens: number; output_tokens: number };
	latencyMs: number;
};
export type JevOptions = {
	apiKey?: string;
	model?: string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	signal?: AbortSignal;
};

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid Jev response");
	}
	return value as Record<string, unknown>;
}
function probability(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("invalid Jev probability");
	}
	return value;
}
function keysMatch(actual: Record<string, unknown>, expected: readonly string[]): void {
	let keys = Object.keys(actual);
	if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
		throw new Error("invalid Jev answer keys");
	}
}
function distribution(value: unknown, expected: readonly string[]): Record<string, number> {
	let raw = object(value);
	keysMatch(raw, expected);
	let result: Record<string, number> = {};
	for (let key of expected) result[key] = probability(raw[key]);
	let total = Object.values(result).reduce((sum, item) => sum + item, 0);
	if (Math.abs(total - 1) > 0.08) throw new Error("invalid Jev distribution");
	return result;
}

export function validateJevResponse(
	value: unknown,
	questions: Record<string, JevQuestion>,
): JevResult {
	let response = object(value);
	if (typeof response.model !== "string" || !response.model || response.model.length > 100) {
		throw new Error("invalid Jev model");
	}
	let usage = object(response.usage);
	for (let count of [usage.input_tokens, usage.output_tokens]) {
		if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error("invalid Jev usage");
	}
	let rawAnswers = object(response.answers);
	keysMatch(rawAnswers, Object.keys(questions));
	let answers: Record<string, JevAnswer> = {};
	for (let [id, question] of Object.entries(questions)) {
		let raw = object(rawAnswers[id]);
		if (raw.type !== question.type) throw new Error("invalid Jev answer type");
		if (question.type === "noul") {
			keysMatch(raw, ["type", "noul"]);
			answers[id] = { type: "noul", noul: probability(raw.noul) };
		} else if (question.type === "choice") {
			keysMatch(raw, ["type", "choice", "confidence", "probabilities"]);
			let options = Object.keys(question.criteria);
			let probabilities = distribution(raw.probabilities, options);
			if (typeof raw.choice !== "string" || !(raw.choice in question.criteria)) {
				throw new Error("invalid Jev choice");
			}
			if (probabilities[raw.choice] + 0.01 < Math.max(...Object.values(probabilities))) {
				throw new Error("invalid Jev winning choice");
			}
			answers[id] = {
				type: "choice",
				choice: raw.choice,
				confidence: probability(raw.confidence),
				probabilities,
			};
		} else {
			keysMatch(raw, ["type", "score", "confidence", "legend", "probabilities"]);
			let levels = question.criteria.map((_, index) => String(index));
			let legend = object(raw.legend);
			keysMatch(legend, levels);
			for (let [index, label] of question.criteria.entries()) {
				if (legend[String(index)] !== label) throw new Error("invalid Jev score legend");
			}
			let probabilities = distribution(raw.probabilities, levels);
			let weighted = levels.reduce((sum, key, index) => sum + index * probabilities[key], 0);
			if (
				typeof raw.score !== "number" || !Number.isFinite(raw.score)
				|| raw.score < 0 || raw.score > levels.length - 1
				|| Math.abs(raw.score - weighted) > 0.12
			) throw new Error("invalid Jev score");
			answers[id] = {
				type: "score",
				score: raw.score,
				confidence: probability(raw.confidence),
				legend: legend as Record<string, string>,
				probabilities,
			};
		}
	}
	return {
		model: response.model,
		answers,
		usage: {
			input_tokens: usage.input_tokens as number,
			output_tokens: usage.output_tokens as number,
		},
		latencyMs: 0,
	};
}

function validateRequest(request: JevRequest): void {
	let count = Object.keys(request.questions).length;
	if (count < 1 || count > 45 || JSON.stringify(request.state).length > 24000) {
		throw new Error("invalid Jev request bounds");
	}
	for (let [id, question] of Object.entries(request.questions)) {
		if (
			!id || id.length > 100 || !/^[\w:-]+$/.test(id)
			|| !question.instructions || question.instructions.length > 1000
		) {
			throw new Error("invalid Jev question");
		}
		if (question.type === "choice") {
			let options = Object.entries(question.criteria);
			if (
				options.length < 2 || options.length > 255
				|| options.some(([key, description]) =>
					!key || key.length > 200 || !description || description.length > 500
				)
			) throw new Error("invalid Jev choice criteria");
		} else if (question.type === "score") {
			if (
				question.criteria.length < 2 || question.criteria.length > 10
				|| question.criteria.some((label) => !label || label.length > 500)
			) {
				throw new Error("invalid Jev score criteria");
			}
		}
	}
}

export async function askJev(request: JevRequest, options: JevOptions = {}): Promise<JevResult> {
	validateRequest(request);
	let apiKey = options.apiKey ?? process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
	if (!apiKey) throw new Error("Jev API key is not configured");
	let model = options.model ?? "jev-latest";
	if (!model || model.length > 100 || !/^[A-Za-z0-9._-]+$/.test(model)) {
		throw new Error("invalid Jev model selection");
	}
	let timeoutMs = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
		throw new Error("invalid Jev timeout");
	}
	let timeout = AbortSignal.timeout(timeoutMs);
	let signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let abortListener!: () => void;
	let aborted = new Promise<never>((_, reject) => {
		abortListener = () => reject(new Error("Jev request aborted"));
		if (signal.aborted) abortListener();
		else signal.addEventListener("abort", abortListener, { once: true });
	});
	let transportError = () =>
		new Error(
			options.signal?.aborted
				? "Jev request aborted"
				: timeout.aborted
				? "Jev request timed out"
				: "Jev request failed",
		);
	let started = performance.now();
	try {
		let response: Response;
		try {
			response = await Promise.race([
				(options.fetch ?? fetch)(ENDPOINT, {
					method: "POST",
					redirect: "error",
					signal,
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({ model, ...request }),
				}),
				aborted,
			]);
		} catch {
			throw transportError();
		}
		if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
		let size = Number(response.headers.get("content-length"));
		if (Number.isFinite(size) && size > 262144) throw new Error("Jev response is too large");
		let reader = response.body?.getReader();
		let decoder = new TextDecoder();
		let body = "";
		let bytes = 0;
		if (reader) {
			while (true) {
				let chunk: Awaited<ReturnType<typeof reader.read>>;
				try {
					chunk = await Promise.race([reader.read(), aborted]);
				} catch {
					void reader.cancel().catch(() => {});
					throw transportError();
				}
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 262144) {
					void reader.cancel().catch(() => {});
					throw new Error("Jev response is too large");
				}
				body += decoder.decode(chunk.value, { stream: true });
			}
			body += decoder.decode();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error("invalid Jev JSON");
		}
		let result = validateJevResponse(parsed, request.questions);
		result.latencyMs = Math.round(performance.now() - started);
		return result;
	} finally {
		signal.removeEventListener("abort", abortListener);
	}
}
