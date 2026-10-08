import { ulid } from "@chopin/dialect";
import type { VisualDecision } from "@chopin/protocol";
import { Visual } from "@chopin/question";
import * as Y from "yjs";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as State from "./state";
import { changed, queued } from "./common";
import type { Lifecycle } from "./common";
import { revisionDigest } from "./revision";

export type VerifyArtifact = (
	artifact: VisualDecision.Definition["artifact"],
) => Promise<boolean>;

/** Internal publication boundary. Callers must authorize the request and supply a trusted verifier. */
export async function create(
	plan: Service.Plan,
	input: VisualDecision.Definition,
	verifyArtifact: VerifyArtifact,
	lifecycle?: Lifecycle,
): Promise<VisualDecision.State> {
	let definition = Visual.definition(input);
	if (definition.definitionRevision !== revisionDigest(definition)) {
		throw new Error("Visual definition revision does not match its content");
	}
	let state: VisualDecision.State | undefined;
	let added = false;
	await queued(plan, async () => {
		if (Service.implementationActive(plan)) throw new Error("Implementation is active");
		let existing = [...plan.visualDecisions.values()].find(
			record => record.definition.requestId === definition.requestId,
		);
		if (existing) {
			if (JSON.stringify(existing.definition) !== JSON.stringify(definition)) {
				throw new Error("Visual request already has a different definition");
			}
			state = State.snapshot(existing);
			return;
		}
		if (plan.visualDecisions.size >= State.MAX_DECISIONS) {
			throw new Error("This document already has 20 visual decisions");
		}
		if (!await verifyArtifact(definition.artifact)) {
			throw new Error("Visual preview artifact is unavailable");
		}
		let id = ulid();
		let stored: State.Stored = {
			id,
			questionId: ulid(),
			definition,
			revision: 0,
			values: { ...definition.baseline },
			edits: {},
		};
		let document = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		document.seq = plan.document.seq;
		try {
			let mutation = room.insertQuestionnaires(document, [{
				value: {
					id,
					visual: "visual-decision@1",
					status: "open",
					questions: [{
						id: stored.questionId,
						header: definition.title,
						prompt: "Choose the visual settings",
						multiple: false,
						options: [{ id: ulid(), label: "Preview" }],
					}],
				},
			}]);
			room.validate(room.project(document));
			if (
				!room.fitsOrShrinks(
					room.project(plan.document),
					room.project(document),
					plan.questions.open.size,
				)
			) throw new Error("The document has no room for another visual decision");
			await Service.publishStaged(
				plan,
				plan.server,
				plan.id,
				{ ...plan, document, visualDecisions: new Map(plan.visualDecisions).set(id, stored) },
				mutation,
				{ retryRejectedCommit: true },
			);
			state = State.snapshot(stored);
			added = true;
		} finally {
			document.doc.destroy();
		}
	}, lifecycle);
	if (added) changed(plan, state!);
	return state!;
}
