import { type Classifiers, createDecide } from "./decisions";

import type { ModelRegistry } from "@bastani/atomic";
import type { Decide } from "./decisions";

type Context = Parameters<ModelRegistry["classify"]>[1];
type Result = Awaited<ReturnType<ModelRegistry["classify"]>>;
type Options = Parameters<ModelRegistry["classify"]>[2];
type Model = { provider: string; id: string };

export type ClassifyCall = { model: Model; context: Context; options: Options };

function entry(model: Model) {
	return {
		type: "classifier",
		...model,
		name: model.id,
		api: "fake-classifier",
		baseUrl: "https://classifier.invalid",
		input: ["text"],
	};
}

/** An Atomic classifier registry that answers from `reply` instead of a provider. */
export function fakeRegistry(
	reply: (context: Context, model: Model) => Partial<Result> | Promise<Partial<Result>>,
	models: Model[] = [{ provider: "typesafe", id: "jev-latest" }],
	available: Model[] = models,
): Classifiers & { calls: ClassifyCall[] } {
	let calls: ClassifyCall[] = [];
	let registry = {
		calls,
		getModelOfType: (_type: string, provider: string, id: string) => {
			let found = models.find(model => model.provider === provider && model.id === id);
			return found && entry(found);
		},
		getAvailableOfType: async (_type: string, provider?: string) =>
			available.filter(model => !provider || model.provider === provider).map(entry),
		getProvider: (provider: string) =>
			models.some(model => model.provider === provider)
				? { id: provider, name: provider, auth: { apiKey: { name: `${provider} API key` } } }
				: undefined,
		classify: async (model: Model, context: Context, options: Options) => {
			calls.push({ model: { provider: model.provider, id: model.id }, context, options });
			return {
				api: "fake-classifier",
				provider: model.provider,
				model: model.id,
				answers: {},
				stopReason: "stop",
				timestamp: 0,
				...await reply(context, model),
			} as Result;
		},
	};
	return registry as unknown as Classifiers & { calls: ClassifyCall[] };
}

/** Translates answers in Chopin's shape into the classifier answers Atomic returns. */
export function classifierAnswers(answers: Record<string, any>): Result["answers"] {
	return Object.fromEntries(
		Object.entries(answers).map(([id, answer]) => [
			id,
			answer.type === "noul"
				? { type: "bool", probability: answer.noul }
				: answer.type === "score"
				? { type: "score", score: answer.score, confidence: answer.confidence }
				: answer,
		]),
	) as Result["answers"];
}

/** A `decide` whose classifier answers every request with `answers` (Chopin's shape). */
export function decideReplying(
	answers: Record<string, any> | ((context: Context) => Record<string, any>),
	usage: Result["usage"] = undefined,
): Decide & { registry: ReturnType<typeof fakeRegistry> } {
	let registry = fakeRegistry(context => ({
		answers: classifierAnswers(typeof answers === "function" ? answers(context) : answers),
		...(usage && { usage }),
	}));
	let decide = createDecide(registry, { model: "typesafe/jev-latest", timeoutMs: 30_000 });
	return Object.assign(decide, { registry });
}
