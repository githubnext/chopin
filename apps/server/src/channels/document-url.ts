import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";

import type { ChannelRecord } from "../storage/model";

type DocumentChannel = Pick<
	ChannelRecord,
	"repositoryOwner" | "repositoryName" | "slug" | "parentChannelId"
>;

export async function documentUrl(
	channel: DocumentChannel,
	channels: { get(id: string): Promise<DocumentChannel | undefined> },
): Promise<string> {
	if (!channel.parentChannelId) {
		return documentPath(channel.repositoryOwner, channel.repositoryName, channel.slug);
	}
	let parent = await channels.get(channel.parentChannelId);
	if (!parent) throw new Error("parent document is unavailable");
	return childDocumentPath(
		channel.repositoryOwner,
		channel.repositoryName,
		parent.slug,
		channel.slug,
	);
}
