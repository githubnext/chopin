import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { input } from "./revise-fields";
import { explicitRequest } from "./revise-requests";
import type { Context } from "./card-tool-context";

export async function reviseOpenDecision(
	context: Context,
	turn: Context["plan"]["chat"]["turn"],
	raw: unknown,
): Promise<{ ok: true; title: string; added: string[] }> {
	let request = context.currentMemberRequest?.();
	if (!request || !turn || context.plan.chat.job) {
		throw new Error("a direct current member request is required");
	}
	return context.exclusive(async () => {
		let { plan } = context;
		let ensureActive = () => {
			if (
				plan.chat.turn !== turn || plan.chat.job
				|| context.currentMemberRequest?.() !== request
			) throw new Error("the member's Planner turn changed before its tool completed");
		};
		ensureActive();
		let args = input(raw);
		if (args.revision !== plan.revision) throw new Error("stale; read_plan again");
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		let record = plan.records.get(args.id);
		let live = Store.get(plan.questions, args.id);
		if (
			!record || !Questions.isOpenStatus(record.status) || !live || live.claim
			|| record.definition.questions.length !== 1
			|| record.definition.questions[0]?.id !== live.definition.questions[0]?.id
			|| !room.hasQuestionnaire(plan.document, args.id, record.definition.questions[0]!.id)
		) throw new Error("that decision is no longer open in this document");
		let question = record.definition.questions[0]!;
		explicitRequest(
			request.text,
			{ id: args.id, header: question.header, question: question.question },
			[...plan.records.values()].map(item => ({
				id: item.id,
				header: item.definition.questions[0]?.header ?? "",
				question: item.definition.questions[0]?.question ?? "",
			})),
			args,
		);
		let seen = new Set(question.options.map(option => option.label.trim().toLocaleLowerCase()));
		if (question.options.length + args.add_options.length > 10) {
			throw new Error("decision has too many options");
		}
		for (let option of args.add_options) {
			let folded = option.label.toLocaleLowerCase();
			if (seen.has(folded)) throw new Error(`duplicate option: ${option.label}`);
			seen.add(folded);
		}
		let result = await Questions.revisePlannerCard(
			plan,
			context.server,
			context.room,
			args.id,
			{ title: args.title, addOptions: args.add_options },
			true,
			ensureActive,
		);
		return { ok: true, ...result };
	});
}
