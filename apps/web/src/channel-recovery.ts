import type * as Api from "./api";

export type ChannelRecovery = {
	channel: Pick<Api.Channel, "id" | "title">;
	repository: Pick<Api.Repository, "owner" | "name" | "fullName">;
};

const KEY = "chopin:channel-recovery:";

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
		&& !!repository
		&& text(repository.owner)
		&& text(repository.name)
		&& text(repository.fullName);
}

export function rememberChannel(
	userId: string,
	channel: ChannelRecovery["channel"],
	repository: ChannelRecovery["repository"],
	storage: Storage = sessionStorage,
): void {
	try {
		storage.setItem(
			`${KEY}${encodeURIComponent(userId)}:${channel.id}`,
			JSON.stringify({ channel, repository }),
		);
	} catch {
		// Recovery context must never prevent the navigation it is meant to help.
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
