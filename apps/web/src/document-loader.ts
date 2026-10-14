import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";

type DocumentReaders = {
	channel: (id: string, signal?: AbortSignal) => Promise<Api.ChannelDetail>;
	document: (
		owner: string,
		repository: string,
		slug: string,
		signal?: AbortSignal,
	) => Promise<Api.ChannelDetail>;
};

export function validatedChildPath(
	child: Api.ChannelDetail,
	parent: Api.ChannelDetail,
): string {
	let sameRepository = child.repository.id === parent.repository.id
		&& child.channel.repositoryId === child.repository.id
		&& parent.channel.repositoryId === parent.repository.id;
	if (
		!child.channel.parentChannelId
		|| child.channel.parentChannelId !== parent.channel.id
		|| parent.channel.parentChannelId
		|| !sameRepository
		|| !parent.channel.slug
		|| !child.channel.slug
	) {
		throw new Api.ApiError("Child document not found", 404);
	}
	return childDocumentPath(
		child.repository.owner,
		child.repository.name,
		parent.channel.slug,
		child.channel.slug,
	);
}

export async function prepareDocumentLoad(
	address:
		| { id: string }
		| {
			owner: string;
			repository: string;
			slug: string;
			parentSlug?: string;
		},
	signal: AbortSignal,
	readers: DocumentReaders = Api,
	onParentReady?: (parent: Api.ChannelDetail) => void,
): Promise<{ detail: Api.ChannelDetail; parent?: Api.ChannelDetail; pathname: string }> {
	if ("id" in address) {
		let detail = await readers.channel(address.id, signal);
		if (!detail.channel.parentChannelId) {
			return {
				detail,
				pathname: documentPath(
					detail.repository.owner,
					detail.repository.name,
					detail.channel.slug,
				),
			};
		}
		let parent = await readers.channel(detail.channel.parentChannelId, signal);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	if (address.parentSlug) {
		// Settle the child read so its early failure does not suppress a parent that is still
		// arriving. A direct child URL can show that parent while its child fails or loads.
		let child = readers.document(address.owner, address.repository, address.slug, signal)
			.then(detail => ({ detail }), error => ({ error }));
		let parent = await readers.document(
			address.owner,
			address.repository,
			address.parentSlug,
			signal,
		);
		if (parent.channel.parentChannelId) throw new Api.ApiError("Child document not found", 404);
		onParentReady?.(parent);
		let result = await child;
		if ("error" in result) throw result.error;
		let detail = result.detail;
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	let detail = await readers.document(
		address.owner,
		address.repository,
		address.slug,
		signal,
	);
	if (detail.channel.parentChannelId) {
		let parent = await readers.channel(detail.channel.parentChannelId, signal);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	return {
		detail,
		pathname: documentPath(
			detail.repository.owner,
			detail.repository.name,
			detail.channel.slug,
		),
	};
}
