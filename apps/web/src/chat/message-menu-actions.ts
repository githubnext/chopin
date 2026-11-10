import { deliveryOf } from "./delivery";

import type { Message } from "./model";

export type MessageMenuActions = { delete: boolean; retry: boolean };

/** Try again and Delete for a person's own message the server refused, which only this browser has. */
export function messageMenuActions(
	message: Message,
	handle: string,
	quietFailures: boolean,
): MessageMenuActions {
	let own = message.author.kind === "member" && message.author.handle === handle;
	let failed = own && deliveryOf(message) === "failed" && !quietFailures;
	return { delete: failed, retry: failed };
}
