/**
 * Chopin's one decisions boundary. Every typed decision (conversation cards, research
 * offers, turn-taking, visual routing, live-build gates) goes through a classifier model
 * in Atomic's registry, named by an exact `provider/id`. Only validated answers leave.
 */
import { AuthStorage, ModelRegistry, ModelRuntime } from "@bastani/atomic";

import type { JevAnswer, JevQuestion, JevRequest, JevResult } from "./jev";

type ClassifierModel = Parameters<ModelRegistry["classify"]>[0];
type ClassifierContext = Parameters<ModelRegistry["classify"]>[1];
type ClassifierResult = Awaited<ReturnType<ModelRegistry["classify"]>>;
type ModelsStore = NonNullable<Parameters<typeof ModelRuntime.create>[0]>["modelsStore"];

export type Classifiers = Pick<
	ModelRegistry,
	"getModelOfType" | "getAvailableOfType" | "getProvider" | "classify"
>;
export type DecisionOptions = {
	/** An exact classifier `provider/id`; defaults to the deployment's decisions model. */
	model?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
};
export type Decide = (request: JevRequest, options?: DecisionOptions) => Promise<JevResult>;

function invalid(message = "invalid decision"): never {
	throw new Error(message);
}

function split(selection: string): { provider: string; id: string } | undefined {
	let slash = selection.indexOf("/");
	if (slash < 1 || slash === selection.length - 1) return undefined;
	return { provider: selection.slice(0, slash), id: selection.slice(slash + 1) };
}

function resolve(registry: Classifiers, selection: string): ClassifierModel | undefined {
	let parts = split(selection);
	return parts && registry.getModelOfType("classifier", parts.provider, parts.id);
}

function validateRequest(request: JevRequest): void {
	let count = Object.keys(request.questions).length;
	if (count < 1 || count > 45 || JSON.stringify(request.state).length > 24000) {
		invalid("invalid decision request");
	}
	for (let [id, question] of Object.entries(request.questions)) {
		if (
			!id || id.length > 100 || !/^[\w:-]+$/.test(id)
			|| !question.instructions || question.instructions.length > 1000
		) invalid("invalid decision request");
		if (question.type === "choice") {
			let options = Object.entries(question.criteria);
			if (
				options.length < 2 || options.length > 255
				|| options.some(([key, description]) =>
					!key || key.length > 200 || !description || description.length > 500
				)
			) invalid("invalid decision request");
		} else if (question.type === "score") {
			if (
				question.criteria.length < 2 || question.criteria.length > 10
				|| question.criteria.some(label => !label || label.length > 500)
			) invalid("invalid decision request");
		}
	}
}

function classifierQuestion(question: JevQuestion): ClassifierContext["questions"][string] {
	if (question.type === "noul") {
		return {
			type: "bool",
			instructions: question.instructions,
			criteria: question.criteria ?? { true: "Yes", false: "No" },
		};
	}
	return question;
}

function probability(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid();
	return value;
}

function keysMatch(actual: object, expected: readonly string[]): void {
	let keys = Object.keys(actual);
	if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) invalid();
}

/** The guarantees callers rely on, whichever classifier answered. */
function answers(
	raw: ClassifierResult["answers"],
	questions: Record<string, JevQuestion>,
): Record<string, JevAnswer> {
	if (!raw || typeof raw !== "object") invalid();
	keysMatch(raw, Object.keys(questions));
	let result: Record<string, JevAnswer> = {};
	for (let [id, question] of Object.entries(questions)) {
		let answer = raw[id];
		if (question.type === "noul") {
			if (answer?.type !== "bool") invalid();
			result[id] = { type: "noul", noul: probability(answer.probability) };
		} else if (question.type === "choice") {
			if (answer?.type !== "choice" || typeof answer.probabilities !== "object") invalid();
			let options = Object.keys(question.criteria);
			keysMatch(answer.probabilities, options);
			let probabilities: Record<string, number> = {};
			for (let option of options) probabilities[option] = probability(answer.probabilities[option]);
			let total = Object.values(probabilities).reduce((sum, item) => sum + item, 0);
			if (Math.abs(total - 1) > 0.08) invalid();
			if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
				invalid();
			}
			if (probabilities[answer.choice]! + 0.01 < Math.max(...Object.values(probabilities))) {
				invalid();
			}
			result[id] = {
				type: "choice",
				choice: answer.choice,
				confidence: probability(answer.confidence),
				probabilities,
			};
		} else {
			if (
				answer?.type !== "score" || typeof answer.score !== "number"
				|| !Number.isFinite(answer.score) || answer.score < 0
				|| answer.score > question.criteria.length - 1
			) invalid();
			result[id] = {
				type: "score",
				score: answer.score,
				confidence: probability(answer.confidence),
				legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
			};
		}
	}
	return result;
}

function failure(result: ClassifierResult): Error {
	// Provider messages can quote response bodies; keep only the status.
	let status = /\((\d{3})\)/.exec(result.errorMessage ?? "")?.[1];
	return new Error(status ? `Decisions HTTP ${status}` : "Decisions request failed");
}

/** A `decide` over `registry`, defaulting to `settings.model` and its timeout. */
export function createDecide(
	registry: Classifiers,
	settings: { model: string; timeoutMs: number },
): Decide {
	return async (request, options = {}) => {
		validateRequest(request);
		let selection = options.model ?? settings.model;
		let model = resolve(registry, selection);
		if (!model) throw new Error(`${selection} is not a classifier model in Atomic's registry`);
		let timeoutMs = options.timeoutMs ?? settings.timeoutMs;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
			invalid("invalid decision timeout");
		}
		let timeout = AbortSignal.timeout(timeoutMs);
		let signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		let stopped = () =>
			new Error(
				options.signal?.aborted ? "Decisions request aborted" : "Decisions request timed out",
			);
		let abortListener!: () => void;
		let aborted = new Promise<never>((_, reject) => {
			abortListener = () => reject(stopped());
			if (signal.aborted) abortListener();
			else signal.addEventListener("abort", abortListener, { once: true });
		});
		let started = performance.now();
		try {
			let context: ClassifierContext = {
				// Atomic types state as an object; Chopin also sends strings, which providers serialize.
				state: request.state as ClassifierContext["state"],
				questions: Object.fromEntries(
					Object.entries(request.questions).map(([id, question]) => [
						id,
						classifierQuestion(question),
					]),
				),
			};
			// One attempt, as before: callers own retries and their fail-open policy.
			let result = await Promise.race([
				registry.classify(model, context, { signal, maxRetries: 0 }),
				aborted,
			]);
			if (signal.aborted) throw stopped();
			if (result.stopReason !== "stop") throw failure(result);
			if (typeof result.model !== "string" || !result.model || result.model.length > 200) invalid();
			return {
				model: result.model,
				answers: answers(result.answers, request.questions),
				usage: {
					input_tokens: Math.max(0, Math.round(result.usage?.input ?? 0)),
					output_tokens: Math.max(0, Math.round(result.usage?.output ?? 0)),
				},
				latencyMs: Math.round(performance.now() - started),
			};
		} finally {
			signal.removeEventListener("abort", abortListener);
		}
	};
}

async function check(
	registry: Classifiers,
	setting: string,
	selection: string,
): Promise<void> {
	let model = resolve(registry, selection);
	if (!model) {
		throw new Error(
			`${setting} ${selection} is not a classifier model in Atomic's registry. `
				+ "Use an exact provider/id such as openai-decisions/gpt-6-luna or typesafe/jev-latest.",
		);
	}
	let available = await registry.getAvailableOfType("classifier", model.provider);
	if (!available.some(entry => entry.id === model.id)) {
		let key = registry.getProvider(model.provider)?.auth.apiKey?.name ?? "API key";
		throw new Error(
			`${setting} ${selection} has no credentials. Set the ${key} for ${model.provider} `
				+ "in the server environment (for example OPENAI_API_KEY for openai-decisions, "
				+ "JEV_API_KEY for typesafe).",
		);
	}
}

/**
 * Checks the configured classifiers at startup and returns the one `decide` every caller
 * uses, or undefined when no decisions model is configured.
 */
export async function openDecisions(
	config: {
		decisionsModel?: string;
		conversationInitiativeModel?: string;
		decisionsTimeoutMs?: number;
	},
	registry?: Classifiers,
): Promise<Decide | undefined> {
	if (!config.decisionsModel) return undefined;
	registry ??= await decisionsRegistry();
	await check(registry, "DECISIONS_MODEL", config.decisionsModel);
	if (config.conversationInitiativeModel) {
		await check(registry, "CONVERSATION_INITIATIVE_MODEL", config.conversationInitiativeModel);
	}
	return createDecide(registry, {
		model: config.decisionsModel,
		timeoutMs: config.decisionsTimeoutMs ?? 30_000,
	});
}

/**
 * Atomic's model registry for decisions. Provider keys come from the environment as in
 * Atomic (OPENAI_API_KEY, TYPESAFE_API_KEY, ...), plus Chopin's JEV_API_KEY for TypeSafe.
 * Provider settings come from Atomic's models.json in its agent directory
 * (`ATOMIC_CODING_AGENT_DIR`). Nothing is read from or written to Atomic's saved logins.
 */
export async function decisionsRegistry(
	env: Record<string, string | undefined> = process.env,
): Promise<ModelRegistry> {
	let entries = new Map<string, unknown>();
	let modelsStore = {
		read: async (provider: string) => entries.get(provider),
		write: async (provider: string, entry: unknown) => void entries.set(provider, entry),
		delete: async (provider: string) => void entries.delete(provider),
	} as ModelsStore;
	let runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(
			env.JEV_API_KEY ? { typesafe: { type: "api_key", key: env.JEV_API_KEY } } : {},
		),
		modelsStore,
		allowModelNetwork: false,
	});
	return new ModelRegistry(runtime);
}
