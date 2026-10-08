import { documentPath } from "@chopin/protocol/document-url";

import type { ChannelRecord } from "../storage/model";

export function documentUrl(
	channel: Pick<ChannelRecord, "repositoryOwner" | "repositoryName" | "slug">,
): string {
	return documentPath(channel.repositoryOwner, channel.repositoryName, channel.slug);
}
