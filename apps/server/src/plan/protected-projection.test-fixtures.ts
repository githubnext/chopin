import { DecisionNode, QuestionnaireNode, ulid } from "@chopin/dialect";
import { $createTextNode, $getRoot, $isParagraphNode, $nodesOfType } from "lexical";
import * as Y from "yjs";
import * as Room from "./room";
import * as Service from "./service";
import * as Questions from "../questions/service";
import { hosted } from "./conversation-persistence.test-fixtures";
import { seededPlan, socket } from "./projection-submit.test-fixtures";

export async function protectedFixture(kind: "decision" | "questionnaire") {
	let context = await hosted();
	let plan = await seededPlan(context);
	let id = ulid();
	if (kind === "decision") {
		let quote = "Neighbor prose.";
		let passage = Room.passageAt(plan.document, [0], quote, 0, quote.length);
		let note = { by: "octocat", text: "Keep the original wording." };
		plan.threads.set(id, {
			id,
			status: "accepted",
			passage,
			notes: [{ id: ulid(), author: "member", handle: "octocat", text: note.text, ts: 1 }],
			quote,
			resolver: "octocat",
			at: Math.floor(Date.now() / 1_000),
		});
		let mutation = Room.insertDecision(plan.document, {
			id,
			quote,
			by: "octocat",
			at: new Date().toISOString(),
			notes: [note],
		});
		if (!mutation) throw new Error("decision projection was not inserted");
		await Service.publish(plan, context.server, context.channel.id, mutation);
	} else {
		let optionId = ulid();
		id = await Questions.insertConversationCard(plan, context.server, context.channel.id, {
			threadId: ulid(),
			header: "Hosting",
			question: "Where should we host?",
			options: [{ id: optionId, label: "S3" }],
		});
		let replies: Array<Record<string, unknown>> = [];
		let ws = socket(context, replies);
		let entry = plan.questions.open.get(id)!;
		let questionId = entry.definition.questions[0]!.id;
		let human = entry.model.fork();
		human.api.val([questionId, "choice"]).set(optionId);
		let patch = human.api.flush();
		if (!patch) throw new Error("answer choice made no patch");
		await Questions.edit(plan, ws, {
			kind: "question:edit",
			ts: 0,
			rid: ulid(),
			id,
			patch: [...patch.toBinary()],
		});
		await Questions.submit(plan, context.server, context.channel.id, ws, {
			kind: "question:submit",
			ts: 0,
			rid: ulid(),
			id,
			revision: plan.questions.open.get(id)!.revision,
		});
		if (plan.records.get(id)?.status !== "answered") {
			throw new Error(`questionnaire sidecar did not become answered: ${JSON.stringify(replies)}`);
		}
	}
	return { context, plan, id };
}

export async function changeProjection(
	peer: Room.Document,
	kind: "decision" | "questionnaire",
	id: string,
	change: "remove" | "alter" | "move-and-edit" | "remove-and-edit" | "alter-and-edit",
): Promise<Uint8Array> {
	let before = Y.encodeStateVector(peer.doc);
	peer.editor.update(() => {
		if (kind === "decision") {
			let node = $nodesOfType(DecisionNode).find(candidate => candidate.getId() === id);
			if (!node) throw new Error("decision projection is missing from peer");
			if (change === "remove" || change === "remove-and-edit") node.remove();
			else if (change === "alter" || change === "alter-and-edit") {
				node.setDecision({ ...node.getDecision(), quote: "Forged quote." });
			}
			if (change !== "remove" && change !== "alter") {
				let paragraph = $getRoot().getFirstChild();
				if (!$isParagraphNode(paragraph)) throw new Error("neighbor paragraph is missing");
				paragraph.append($createTextNode(" Edited."));
				if (change === "move-and-edit") paragraph.insertBefore(node);
			}
		} else {
			let node = $nodesOfType(QuestionnaireNode).find(candidate => candidate.getId() === id);
			if (!node) throw new Error("questionnaire projection is missing from peer");
			if (change === "remove" || change === "remove-and-edit") node.remove();
			else if (change === "alter" || change === "alter-and-edit") {
				node.setQuestionnaire({ ...node.getQuestionnaire(), status: "open" });
			}
			if (change !== "remove" && change !== "alter") {
				let paragraph = $getRoot().getFirstChild();
				if (!$isParagraphNode(paragraph)) throw new Error("neighbor paragraph is missing");
				paragraph.append($createTextNode(" Edited."));
				if (change === "move-and-edit") paragraph.insertBefore(node);
			}
		}
	}, { discrete: true });
	await Room.settle();
	return Y.encodeStateAsUpdate(peer.doc, before);
}
