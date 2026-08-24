import type { Research } from "@chopin/protocol";
import type * as Api from "./api";

export type ResearchChannelGroup = {
	channel: Api.ResearchParentChannel;
	workspaces: Research.WorkspaceSummary[];
};

export type ResearchRepositoryState = {
	status: "loading" | "ready" | "error";
	channels: ResearchChannelGroup[];
	truncated?: boolean;
	message?: string;
};

export type LoadedResearch = Record<string, ResearchRepositoryState>;

export function currentResearchRequest(
	loads: ReadonlyMap<string, AbortController>,
	repositoryId: string,
	controller: AbortController,
): boolean {
	return !controller.signal.aborted && loads.get(repositoryId) === controller;
}

export function beginResearchLoad(current?: ResearchRepositoryState): ResearchRepositoryState {
	return {
		status: "loading",
		channels: current?.channels ?? [],
		...(current?.truncated === undefined ? {} : { truncated: current.truncated }),
	};
}

export function newestResearchWorkspace(
	current: Research.WorkspaceSummary,
	replacement: Research.WorkspaceSummary,
): Research.WorkspaceSummary {
	if (current.id !== replacement.id) return replacement;
	if (current.revision !== replacement.revision) {
		return current.revision > replacement.revision ? current : replacement;
	}
	return current.updatedAt > replacement.updatedAt ? current : replacement;
}

export function completeResearchLoad(
	current: ResearchRepositoryState,
	page: Api.RepositoryResearchPage,
	preserveMissing = true,
): ResearchRepositoryState {
	let groups = new Map<string, ResearchChannelGroup>();
	for (let group of page.channels) {
		groups.set(group.channel.id, {
			channel: group.channel,
			workspaces: [...group.workspaces],
		});
	}
	for (let currentGroup of current.channels) {
		let loaded = groups.get(currentGroup.channel.id);
		if (!loaded && (preserveMissing || page.truncated)) {
			groups.set(currentGroup.channel.id, currentGroup);
			continue;
		}
		if (!loaded) continue;
		let workspaces = new Map(loaded.workspaces.map(workspace => [workspace.id, workspace]));
		for (let workspace of currentGroup.workspaces) {
			let replacement = workspaces.get(workspace.id);
			if (replacement) {
				workspaces.set(workspace.id, newestResearchWorkspace(workspace, replacement));
			} else if (preserveMissing || page.truncated) workspaces.set(workspace.id, workspace);
		}
		groups.set(currentGroup.channel.id, {
			channel: loaded.channel,
			workspaces: [...workspaces.values()],
		});
	}
	return {
		status: "ready",
		channels: [...groups.values()],
		truncated: page.truncated,
	};
}

export function failResearchLoad(
	current: ResearchRepositoryState,
	error: unknown,
): ResearchRepositoryState {
	return {
		...current,
		status: "error",
		message: error instanceof Error ? error.message : "Could not load research workspaces",
	};
}

export function upsertLoadedResearch(
	loaded: LoadedResearch,
	repositoryId: string,
	channel: Api.ResearchParentChannel,
	workspace: Research.WorkspaceSummary,
): LoadedResearch {
	let current = loaded[repositoryId] ?? beginResearchLoad();
	let found = current.channels.find(group => group.channel.id === channel.id);
	let channels = found
		? current.channels.map(group => {
			if (group.channel.id !== channel.id) return group;
			let existing = group.workspaces.find(value => value.id === workspace.id);
			return {
				channel: { ...group.channel, ...channel },
				workspaces: existing
					? group.workspaces.map(value =>
						value.id === workspace.id
							? newestResearchWorkspace(value, workspace)
							: value
					)
					: [...group.workspaces, workspace],
			};
		})
		: [...current.channels, { channel, workspaces: [workspace] }];
	return { ...loaded, [repositoryId]: { ...current, channels } };
}

export function removeLoadedResearchChannel(
	loaded: LoadedResearch,
	channelId: string,
): LoadedResearch {
	let next = loaded;
	for (let [repositoryId, state] of Object.entries(loaded)) {
		if (!state.channels.some(group => group.channel.id === channelId)) continue;
		if (next === loaded) next = { ...loaded };
		next[repositoryId] = {
			...state,
			channels: state.channels.filter(group => group.channel.id !== channelId),
		};
	}
	return next;
}

export function researchByChannel(
	loaded: LoadedResearch,
): ReadonlyMap<string, ResearchChannelGroup> {
	let groups = new Map<string, ResearchChannelGroup>();
	for (let state of Object.values(loaded)) {
		for (let group of state.channels) groups.set(group.channel.id, group);
	}
	return groups;
}
