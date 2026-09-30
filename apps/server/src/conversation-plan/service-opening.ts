import * as Service from "../plan/service";

import type { Room } from "../rooms";

type OpeningRoom<P> = { plan?: P; opening?: Promise<P> };

/** Complete all setup before exposing a plan to concurrent socket frames. */
export async function publishOpenedPlan<P>(
	room: OpeningRoom<P>,
	opened: P,
	prepare: () => Promise<void> | void,
): Promise<P> {
	await prepare();
	room.plan = opened;
	return opened;
}

/** Preparation owns an unpublished document until close intent has been checked. */
export async function prepareOpenedPlan(
	room: Room,
	opened: Service.Plan,
	prepare: () => Promise<void> | void,
): Promise<Service.Plan> {
	try {
		if (room.closing) throw new Error("document is unavailable");
		await prepare();
		if (room.closing) throw new Error("document is unavailable");
		room.plan = opened;
		return opened;
	} catch (error) {
		try {
			await Service.abortOpening(opened);
		} catch (cleanupError) {
			let failure = new AggregateError(
				[error, cleanupError],
				"document preparation and cleanup failed",
				{
					cause: cleanupError,
				},
			);
			throw failure;
		}
		throw error;
	}
}
