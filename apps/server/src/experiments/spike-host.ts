import { limits } from "@chopin/experiment";
import { parse } from "@chopin/dialect/parse";
import { serialize } from "@chopin/dialect/serialize";
import { ulid } from "@chopin/dialect/ulid";

import * as room from "../plan/room";
import * as Service from "../plan/service";
import { callouts, placeSpikeCallout } from "./spike-placement";
import { eligible, renderKey, spikeBrief, spikeCallout, text } from "./spikes";

import type { Connections } from "./connections";
import type { Experiments } from "./service";
import type { SpikeHost } from "./spike-scout";

type Options = {
	service: Experiments;
	connections: Connections;
	withPlan: <T>(channelId: string, action: (plan: Service.Plan) => Promise<T>) => Promise<T>;
};

/** Spike records live with investigations; their callouts are projections placed after commit. */
export function spikeHost({ service, connections, withPlan }: Options): SpikeHost {
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
				return {
					repositoryId: plan.persistence.repositoryId,
					live: !!plan.live,
					blocks: parse(current.source).children.filter(eligible).map(node => ({
						digest: room.digest(serialize({ type: "root", children: [node] })),
						text: text(node).replace(/\s+/g, " ").trim().slice(0, 4000),
					})),
					callouts: callouts(current.source),
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
			let value = await service.create(channelId, owner, spikeBrief(block.text), id, undefined, {
				digest: block.digest,
				passage: block.text,
				callout,
				login: connection.login,
				placed: false,
			});
			let placed = await withPlan(
				channelId,
				plan =>
					placeSpikeCallout(plan, { callout, node: spikeCallout(value), after: block.digest }),
			);
			if (placed !== "placed") {
				await dismiss(channelId, id);
				return;
			}
			await service.mutate(id, item => {
				item.spike!.placed = true;
				item.spike!.rendered = "running";
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
				if (!spike.placed || spike.dismissed) continue;
				let key = renderKey(value);
				if (key === spike.rendered) continue;
				let placed = await withPlan(
					channelId,
					plan => placeSpikeCallout(plan, { callout: spike.callout, node: spikeCallout(value) }),
				);
				if (placed === "missing") await dismiss(channelId, value.id);
				else if (placed !== "deferred") {
					await service.mutate(value.id, item => {
						item.spike!.rendered = key;
					});
				}
			}
		},
	};
}
