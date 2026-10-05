import * as Draft from "@chopin/draft";
import type { ConversationPlan } from "@chopin/protocol";
import type { Dependencies, Member } from "./processor-types";
import { assertStateShape } from "./validation";
import { id, knownKeys, record } from "./validation-fields";

export function createResearchDraftService(deps: Dependencies, active: () => boolean) {
	let presence = new Map<string, { offerId: string; handle: string }>();
	async function edit(
		offerId: string,
		operation: ConversationPlan.ResearchEdit["operation"],
		actor: Member,
	) {
		let result = await deps.exclusive(async () => {
			if (!active()) throw new Error("Research editing is unavailable");
			id(offerId);
			let op = record(operation);
			knownKeys(
				op,
				operation.kind === "patch"
					? ["kind", "patch"]
					: operation.kind === "addition"
					? ["kind", "id", "actionId", "choice"]
					: ["kind"],
			);
			let previous = deps.plan.conversationPlan;
			let current = previous.researchOffers?.find(item => item.id === offerId);
			if (!current?.workflow) throw new Error("This research offer has no shared draft");
			if (current.status !== "offered") return { offer: current, revision: previous.revision };
			let offer = structuredClone(current);
			let workflow = offer.workflow!;
			if (operation.kind === "begin") {
				if (workflow.mode === "human") return { offer: current, revision: previous.revision };
				workflow.mode = "human";
				workflow.generation++;
				workflow.generationBrief = offer.brief;
				workflow.preparation = "ready";
				workflow.draft = Draft.binary(Draft.create(offer.brief));
				delete workflow.jobId;
			} else if (operation.kind === "patch") {
				if (workflow.mode !== "human" || !workflow.draft) {
					throw new Error("Open the shared draft before editing");
				}
				let model = Draft.apply(Draft.restore(workflow.draft), operation.patch);
				let binary = Draft.binary(model);
				if (JSON.stringify(binary) === JSON.stringify(workflow.draft)) {
					return { offer: current, revision: previous.revision };
				}
				workflow.draft = binary;
				offer.brief = Draft.read(model);
				if (!workflow.editedBy.includes(actor.handle)) workflow.editedBy.push(actor.handle);
			} else if (operation.kind === "addition") {
				id(operation.id);
				id(operation.actionId);
				if (!["apply", "dismiss"].includes(operation.choice)) {
					throw new Error("Invalid addition action");
				}
				let addition = workflow.additions.find(item => item.id === operation.id);
				if (!addition) throw new Error("Research addition not found");
				if (addition.status !== "pending") return { offer: current, revision: previous.revision };
				if (workflow.additions.some(item => item.actionId === operation.actionId)) {
					throw new Error("Addition action ID already used");
				}
				addition.status = operation.choice === "apply" ? "applied" : "dismissed";
				addition.actor = actor.handle;
				addition.actionId = operation.actionId;
				if (operation.choice === "apply") {
					let model = workflow.draft ? Draft.restore(workflow.draft) : Draft.create(offer.brief);
					let patch = Draft.change(
						model,
						`${offer.brief}${offer.brief ? "\n\n" : ""}${addition.text}`,
					);
					if (patch) model = Draft.apply(model, patch);
					workflow.draft = Draft.binary(model);
					offer.brief = Draft.read(model);
					workflow.mode = "human";
					if (!workflow.editedBy.includes(actor.handle)) workflow.editedBy.push(actor.handle);
				}
				workflow.generation++;
				workflow.preparation = "ready";
			} else if (operation.kind === "retry") {
				if (workflow.preparation !== "failed") {
					return { offer: current, revision: previous.revision };
				}
				workflow.generation++;
				workflow.generationBrief = offer.brief;
				workflow.preparation = "pending";
				delete workflow.jobId;
			} else throw new Error("Invalid research edit operation");
			workflow.revision++;
			let next = {
				...previous,
				revision: previous.revision + 1,
				researchOffers: previous.researchOffers!.map(item => item.id === offerId ? offer : item),
			};
			assertStateShape(next);
			deps.plan.conversationPlan = next;
			try {
				await deps.persist();
			} catch (error) {
				deps.plan.conversationPlan = previous;
				throw error;
			}
			deps.publish(next);
			return { offer, revision: next.revision };
		});
		deps.researchChanged?.();
		return result;
	}
	function focus(client: string, handle: string, offerId: string, editing: boolean) {
		id(offerId);
		if (typeof editing !== "boolean" || !active()) return;
		let current = presence.get(client);
		if (current && (current.offerId !== offerId || !editing)) {
			deps.researchPresence?.({
				kind: "conversation-plan:research-presence",
				ts: 0,
				client,
				handle,
				offerId: current.offerId,
				editing: false,
			});
			presence.delete(client);
		}
		if (
			!editing
			|| !deps.plan.conversationPlan.researchOffers?.some(item =>
				item.id === offerId && item.status === "offered"
			)
		) return;
		presence.set(client, { offerId, handle });
		for (let [peer, value] of presence) {
			deps.researchPresence?.({
				kind: "conversation-plan:research-presence",
				ts: 0,
				client: peer,
				handle: value.handle,
				offerId: value.offerId,
				editing: true,
			});
		}
	}
	function away(client: string) {
		let current = presence.get(client);
		if (current) focus(client, current.handle, current.offerId, false);
	}
	return { edit, focus, away };
}
