import * as Question from "@chopin/question";
import * as Service from "./service";
import { openPlan } from "../testing/plan";

import type { Definition } from "@chopin/question";

export function definition(): Definition {
	return {
		questions: [{
			id: "saved-question",
			header: "Hosting",
			question: "Where should we host?",
			multiple: false,
			options: [
				{ id: "saved-a", label: "Cloud", description: "Managed" },
				{ id: "saved-b", label: "Own server", description: "" },
			],
		}],
	};
}

export function draft(value = definition()) {
	return {
		id: "saved-card",
		definition: value,
		model: [...Question.create(value).toBinary()],
		revision: 0,
	};
}

export function legacyRecord(value = definition()) {
	return { id: "saved-card", definition: value, status: "open" };
}

export async function stored(
	questions: unknown[],
	openQuestions: unknown[],
	transcript: unknown[] = [],
) {
	let context = await openPlan("# Questions\n", { questions, openQuestions, transcript });
	return {
		...context,
		open: () => Service.open(context.channel.id, context.backend, context.server),
	};
}

export async function rejected(pending: ReturnType<typeof stored>) {
	try {
		let context = await pending;
		await Service.close(context.plan);
		return undefined;
	} catch (err) {
		return err;
	}
}
