import type { Followthrough } from "@chopin/protocol";
import { response } from "./api";

export function updateFollowthrough(
	channelId: string,
	view: Followthrough.View,
	action: Followthrough.Action,
): Promise<Followthrough.View> {
	return response(
		`/api/channels/${encodeURIComponent(channelId)}/followthrough/${
			encodeURIComponent(view.id)
		}/${action}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ revision: view.revision }),
		},
	);
}
