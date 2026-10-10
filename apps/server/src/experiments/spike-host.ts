import { limits } from "@chopin/experiment";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { ulid } from "@chopin/dialect/ulid";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { calloutDigest, calloutId, placeSpikeCallout } from "./spike-placement";
import { eligible, renderKey, spikeBrief, spikeCallout, text } from "./spikes";

import type { Connections } from "./connections";
import type { Experiments } from "./service";
import type { Investigation } from "@chopin/experiment/records";
import type { SpikeHost } from "./spike-scout";

type Options = {
	service: Experiments;
	connections: Connections;
	withPlan: <T>(channelId: string, action: (plan: Service.Plan) => Promise<T>) => Promise<T>;
	/** A spike's result was just written into its callout. */
	landed?: (channelId: string, value: Investigation) => void;
};

/** Spike records live with investigations; their callouts are projections placed after commit. */
export function spikeHost({ service, connections, withPlan, landed }: Options): SpikeHost {
	let spikes = async (channelId: string) =>
		(await service.store.list(channelId)).filter(value => value.spike);
	let dismiss = async (_channelId: string, id: string) => {
		await service.mutate(id, value => {
			value.spike!.dismissed = true;
		});
		await service.stop(id, "cancelled", "Dismissed.");
	};
	return {
		snapshot: channelId =>
			withPlan(channelId, async plan => {
				let current = await Service.readCurrentDocument(plan);
				let children = parse(current.source).children;
				return {
					repositoryId: plan.persistence.repositoryId,
					live: !!plan.live,
					blocks: children.flatMap((node, index) => {
						if (!eligible(node)) return [];
						let next = children[index + 1];
						let after = next && calloutId(next);
						return [{
							digest: room.digest(serialize({ type: "root", children: [node] })),
							text: text(node).replace(/\s+/g, " ").trim().slice(0, 4000),
							...(after ? { calloutAfter: after } : {}),
						}];
					}),
					callouts: new Set(children.flatMap(node => calloutId(node) ?? [])),
				};
			}),
		spikes,
		async connection(repositoryId, owner, channelId) {
			let found = connections.candidates(repositoryId, owner, channelId)[0];
			return found && { id: found.id, login: found.login };
		},
		async start(channelId, { owner, connection, block }) {
			let id = crypto.randomUUID();
			let callout = ulid();
			let created = await service.create(channelId, owner, spikeBrief(block.text), id, undefined, {
				digest: block.digest,
				passage: block.text,
				callout,
				login: connection.login,
				placed: false,
				placing: true,
			});
			let node = spikeCallout(created);
			// Persist what is about to be published, so recovery recognises it as untouched.
			let value = await service.mutate(id, item => {
				item.spike!.calloutDigest = calloutDigest(node);
			});
			let placed = await withPlan(
				channelId,
				plan => placeSpikeCallout(plan, { callout, node, after: block.digest }),
			);
			if (placed.status !== "placed") {
				await dismiss(channelId, id);
				return;
			}
			await service.mutate(id, item => {
				item.spike!.placed = true;
				delete item.spike!.placing;
				item.spike!.rendered = renderKey(created);
				item.spike!.callout = placed.callout;
				item.spike!.calloutDigest = placed.digest;
			});
			let live = connections.get(connection.id);
			try {
				if (!live) throw new Error("connection gone");
				let context = await withPlan(channelId, plan => Service.readCurrentDocument(plan));
				await service.authorize(id, live.id, {
					id,
					documentId: channelId,
					requester: owner,
					authorizer: owner,
					brief: value.brief,
					source: live.source,
					context: `Document revision ${context.revision}\n${context.source}`.slice(
						0,
						limits.context,
					),
				});
				connections.use(channelId, live.id);
			} catch {
				await service.stop(id, "failed", "The local agent disconnected before it could start.");
			}
		},
		dismiss,
		async refresh(channelId) {
			for (let value of await spikes(channelId)) {
				let spike = value.spike!;
				if (spike.dismissed) continue;
				// A crash after publishing but before `placed` persisted: only ever look in place.
				let recovering = !spike.placed && !!spike.placing;
				if (!spike.placed && !recovering) continue;
				let key = renderKey(value);
				if (!recovering && key === spike.rendered) continue;
				let placed = await withPlan(
					channelId,
					plan =>
						placeSpikeCallout(plan, {
							callout: spike.callout,
							node: spikeCallout(value),
							rendered: spike.calloutDigest,
						}, { queued: true }),
				);
				if (placed.status === "missing") await dismiss(channelId, value.id);
				else if (placed.status !== "deferred") {
					let { callout, digest } = placed;
					await service.mutate(value.id, item => {
						item.spike!.placed = true;
						delete item.spike!.placing;
						item.spike!.rendered = key;
						item.spike!.callout = callout;
						item.spike!.calloutDigest = digest;
					});
					if (placed.status === "placed" && key === "completed" && spike.rendered !== key) {
						landed?.(channelId, value);
					}
				}
			}
		},
	};
}
