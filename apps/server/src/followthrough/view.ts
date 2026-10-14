import type { Followthrough as Wire } from "@chopin/protocol";
import type { Followthrough } from "../storage/followthrough";

export function followthroughView(value: Followthrough): Wire.View {
	return {
		id: value.id,
		revision: value.revision,
		status: value.status,
		...(value.reason ? { reason: value.reason } : {}),
	};
}
