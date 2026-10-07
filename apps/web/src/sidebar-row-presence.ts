import { useState } from "react";

type Group = { parent: { id: string } };

export type PresenceRow<T extends Group> = {
	enter: boolean;
	exiting: boolean;
	group: T;
};

export type Track<T extends Group> = {
	baseline: boolean;
	entered: ReadonlySet<string>;
	exiting: ReadonlyMap<string, { group: T; index: number }>;
	groups: readonly T[];
	scope: string;
	signature: string;
};

export function trackSignature(groups: readonly Group[]): string {
	return groups.map(group => group.parent.id).join(",");
}

export function initialTrack<T extends Group>(
	groups: readonly T[],
	ready: boolean,
	scope: string,
): Track<T> {
	return {
		baseline: ready,
		entered: new Set(),
		exiting: new Map(),
		groups,
		scope,
		signature: trackSignature(groups),
	};
}

/**
 * Rows inserted or removed after the list settled animate. Rows that appear
 * while a list loads, or when its scope changes (archive mode, project switch),
 * are baseline. A refetch (`ready` false) keeps rows already exiting so they
 * can finish; it never starts new animations.
 */
export function nextTrack<T extends Group>(
	track: Track<T>,
	groups: readonly T[],
	ready: boolean,
	scope: string,
	immediately: boolean,
): Track<T> {
	let signature = trackSignature(groups);
	if (track.signature === signature && track.scope === scope && track.baseline === ready) {
		return track;
	}
	let sameScope = track.scope === scope && !immediately;
	let steady = track.baseline && ready && sameScope;
	let ids = new Set(groups.map(group => group.parent.id));
	let entered = new Set(steady ? track.entered : []);
	let exiting = new Map(sameScope ? track.exiting : []);
	for (let id of ids) exiting.delete(id);
	if (steady) {
		let previous = new Set(track.groups.map(group => group.parent.id));
		for (let id of ids) if (!previous.has(id)) entered.add(id);
		track.groups.forEach((group, index) => {
			if (!ids.has(group.parent.id)) exiting.set(group.parent.id, { group, index });
		});
	}
	return { baseline: ready, entered, exiting, groups, scope, signature };
}

export function presenceRows<T extends Group>(
	track: Track<T>,
	groups: readonly T[],
): PresenceRow<T>[] {
	let rows: PresenceRow<T>[] = groups.map(group => ({
		enter: track.entered.has(group.parent.id),
		exiting: false,
		group,
	}));
	for (let { group, index } of [...track.exiting.values()].sort((a, b) => a.index - b.index)) {
		rows.splice(Math.min(index, rows.length), 0, { enter: false, exiting: true, group });
	}
	return rows;
}

export function useSidebarRowPresence<T extends Group>(
	groups: readonly T[],
	{ immediately, ready, scope }: { immediately: boolean; ready: boolean; scope: string },
) {
	let [track, setTrack] = useState(() => initialTrack(groups, ready, scope));
	let next = nextTrack(track, groups, ready, scope, immediately);
	if (next !== track) setTrack(next);
	return {
		finish(id: string) {
			setTrack(current => {
				if (!current.exiting.has(id)) return current;
				let exiting = new Map(current.exiting);
				exiting.delete(id);
				return { ...current, exiting };
			});
		},
		rows: presenceRows(next, groups),
	};
}
