import * as Plan from "../plan/service";
import type { Room } from "../rooms";

export type PlacementDependencies = {
	get(channelId: string): Pick<Room, "plan" | "closing"> | undefined;
	exclusive<T>(channelId: string, action: () => Promise<T>): Promise<T>;
	detached<T>(channelId: string, action: (plan: Plan.Plan) => Promise<T>): Promise<T>;
};

export function placeResearchReference(
	channelId: string,
	workspaceId: string,
	deps: PlacementDependencies,
): Promise<"placed" | "deferred"> {
	// Closing waits for Chat while holding this lock; a host tool must not wait behind it.
	if (deps.get(channelId)?.closing) return Promise.resolve("deferred");
	return deps.exclusive(channelId, async () => {
		let room = deps.get(channelId);
		if (room?.closing) return "deferred";
		let active = room?.plan;
		if (active) {
			if (active.persistence.closing) return "deferred";
			return Plan.placeResearchReference(active, workspaceId);
		}
		return deps.detached(channelId, plan => {
			if (plan.persistence.closing) return Promise.resolve("deferred");
			return Plan.placeResearchReference(plan, workspaceId);
		});
	});
}
