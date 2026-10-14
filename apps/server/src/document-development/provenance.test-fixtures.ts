import * as Y from "yjs";
import { $getRoot, $isElementNode, $isTextNode } from "lexical";
import * as room from "../plan/room";
import * as edit from "../plan/edit";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { initial } from "./state";

import type { Reconciliation } from "./reconcile";
import type { Socket } from "../wire";

export async function fixture(source = "# Notes\n\nA draft observation.\n\nHuman context.\n") {
	let context = await openPlan(source);
	let { plan } = context;
	let hash = room.digests(plan.document)[1]!;
	plan.documentDevelopment = {
		...initial(),
		passages: [{
			id: "passage-1",
			anchor: room.anchorAt(plan.document, 1, hash),
			generatedDigest: hash,
			sourceIds: ["m1"],
			status: "generated",
		}],
	};
	await Service.persist(plan);
	context.broadcasts.length = 0;
	return context;
}

export function request(
	plan: Service.Plan,
	overrides: Partial<Reconciliation> = {},
): Reconciliation {
	return {
		jobId: "job-1",
		messageId: "m2",
		sourceIds: ["m1", "m2"],
		passages: plan.documentDevelopment!.passages.map(item => ({
			id: item.id,
			digest: item.generatedDigest,
		})),
		changes: [{ id: "passage-1", markdown: "A more useful draft.", sourceIds: ["m2"] }],
		removals: [],
		...overrides,
	};
}

type ClientChange = { index: number; text: string } | edit.Operation[];
type ClientUpdate = { epoch: string; id: string; update: string };

/** A browser retains its own original history until it receives a server publication. */
export async function clientPeer(plan: Service.Plan) {
	let peer = await room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		room.project(plan.document),
		[],
	);
	return {
		destroy: () => peer.doc.destroy(),
		full: (): ClientUpdate => ({
			epoch: peer.epoch,
			id: crypto.randomUUID(),
			update: Buffer.from(Y.encodeStateAsUpdate(peer.doc)).toString("base64"),
		}),
		async update(change: ClientChange): Promise<ClientUpdate> {
			let updates: Uint8Array[] = [];
			let collect = (update: Uint8Array) => updates.push(update);
			peer.doc.on("update", collect);
			try {
				if (Array.isArray(change)) {
					let outcome = edit.apply(
						{ ...plan, document: peer, outlines: new Map() },
						plan.revision,
						change,
					);
					if (!outcome.ok) throw new Error("invalid fixture edit");
				} else {
					peer.editor.update(() => {
						let block = $getRoot().getChildren()[change.index];
						let text = $isElementNode(block) ? block.getFirstDescendant() : undefined;
						if (!$isTextNode(text)) throw new Error("fixture block is not text");
						text.setTextContent(change.text);
					}, { discrete: true });
					await room.settle();
				}
				return {
					epoch: peer.epoch,
					id: crypto.randomUUID(),
					update: Buffer.from(Y.mergeUpdates(updates)).toString("base64"),
				};
			} finally {
				peer.doc.off("update", collect);
			}
		},
	};
}

export async function submitClientUpdate(
	plan: Service.Plan,
	message: ClientUpdate,
	drain = true,
	frames: string[] = [],
): Promise<void> {
	let ws = {
		data: {
			canEdit: true,
			room: plan.id,
			handle: "human",
			principalId: "U_test",
			client: "peer",
		},
		send(value: string) {
			frames.push(value);
		},
		publish() {},
		close() {},
	} as unknown as Socket;
	Service.submit(plan, ws, {
		kind: "plan:update",
		ts: 0,
		rid: crypto.randomUUID(),
		...message,
	});
	if (drain) await Service.drain(plan);
}

/** Exercise real browser Yjs admission, including its delayed batching queue. */
export async function clientEdit(plan: Service.Plan, change: ClientChange, drain = true) {
	let peer = await clientPeer(plan);
	try {
		let message = await peer.update(change);
		await submitClientUpdate(plan, message, drain);
		return message;
	} finally {
		peer.destroy();
	}
}
