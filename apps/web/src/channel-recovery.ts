import { documentPath } from "@chopin/protocol/document-url";

import type * as Api from "./api";

export type ChannelRecovery = {
	channel: Pick<Api.Channel, "id" | "title"> & Partial<Pick<Api.Channel, "slug">>;
	repository: Pick<Api.Repository, "owner" | "name" | "fullName">;
};

const KEY = "chopin:channel-recovery:";
const PATH_KEY = "chopin:document-recovery:";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function recovery(value: unknown, id: string): value is ChannelRecovery {
	let item = record(value);
	let channel = record(item?.channel);
	let repository = record(item?.repository);
	return !!item
		&& !!channel
		&& channel.id === id
		&& text(channel.title)
		&& (channel.slug === undefined || text(channel.slug))
		&& !!repository
		&& text(repository.owner)
		&& text(repository.name)
		&& text(repository.fullName);
}

export function rememberChannel(
	userId: string,
	channel: Pick<Api.Channel, "id" | "title" | "slug">,
	repository: ChannelRecovery["repository"],
	storage: Storage = sessionStorage,
): void {
	try {
		storage.setItem(
			`${KEY}${encodeURIComponent(userId)}:${channel.id}`,
			JSON.stringify({ channel, repository }),
		);
		storage.setItem(
			`${PATH_KEY}${encodeURIComponent(userId)}:${
				documentPath(
					repository.owner,
					repository.name,
					channel.slug,
				)
			}`,
			JSON.stringify({ channel, repository }),
		);
	} catch {
		// Recovery context must never prevent the navigation it is meant to help.
	}
}

export function forgetChannel(
	userId: string,
	channel: Pick<Api.Channel, "id" | "repositoryOwner" | "repositoryName" | "slug">,
	storage: Storage = sessionStorage,
): void {
	try {
		let userPathPrefix = `${PATH_KEY}${encodeURIComponent(userId)}:`;
		let keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
			.filter((key): key is string => !!key);
		for (let key of keys) {
			if (key === `${KEY}${encodeURIComponent(userId)}:${channel.id}`) {
				storage.removeItem(key);
				continue;
			}
			if (!key.startsWith(userPathPrefix)) continue;
			let value = JSON.parse(storage.getItem(key) ?? "null") as unknown;
			if (recovery(value, channel.id)) storage.removeItem(key);
		}
	} catch {
		// Recovery cleanup must not prevent deletion from completing locally.
	}
}

export function readDocumentRecovery(
	userId: string,
	owner: string,
	repository: string,
	slug: string,
	storage: Storage = sessionStorage,
): ChannelRecovery | undefined {
	try {
		let path = documentPath(owner, repository, slug);
		let value: unknown = JSON.parse(
			storage.getItem(`${PATH_KEY}${encodeURIComponent(userId)}:${path}`) ?? "null",
		);
		let item = record(value);
		let storedChannel = record(item?.channel);
		let storedRepository = record(item?.repository);
		return text(storedChannel?.id)
				&& text(storedChannel.slug)
				&& storedChannel.slug === slug
				&& storedRepository?.owner === owner
				&& storedRepository.name === repository
				&& recovery(value, storedChannel.id)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

export function readChannelRecovery(
	userId: string,
	id: string,
	storage: Storage = sessionStorage,
): ChannelRecovery | undefined {
	try {
		let value: unknown = JSON.parse(
			storage.getItem(`${KEY}${encodeURIComponent(userId)}:${id}`) ?? "null",
		);
		return recovery(value, id) ? value : undefined;
	} catch {
		return undefined;
	}
}
