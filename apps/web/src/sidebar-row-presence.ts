import { useState } from "react";

export type PresenceRow<T extends { parent: { id: string } }> = {
	enter: boolean;
	exiting: boolean;
	group: T;
};

type Track<T extends { parent: { id: string } }> = {
	baseline: boolean;
	entered: ReadonlySet<string>;
	exiting: ReadonlyMap<string, { group: T; index: number }>;
	groups: readonly T[];
	scope: string;
	signature: string;
};

/**
 * Tracks which sidebar rows were inserted or removed after the list settled.
 * Rows that appear while a list loads or when its scope changes (archive mode,
 * project switch) are baseline, so only live inserts and removals animate.
 */
export function useSidebarRowPresence<T extends { parent: { id: string } }>(
	groups: readonly T[],
	{ immediately, ready, scope }: { immediately: boolean; ready: boolean; scope: string },
) {
	let signature = groups.map(group => group.parent.id).join(",");
	let [track, setTrack] = useState<Track<T>>(() => ({
		baseline: ready,
		entered: new Set(),
		exiting: new Map(),
		groups,
		scope,
		signature,
	}));
	if (track.signature !== signature || track.scope !== scope || track.baseline !== ready) {
		let steady = track.baseline && ready && track.scope === scope && !immediately;
		let ids = new Set(groups.map(group => group.parent.id));
		let entered = new Set(steady ? track.entered : []);
		let exiting = new Map(steady ? track.exiting : []);
		if (steady) {
			let previous = new Set(track.groups.map(group => group.parent.id));
			for (let id of ids) {
				if (!previous.has(id)) entered.add(id);
				exiting.delete(id);
			}
			track.groups.forEach((group, index) => {
				if (!ids.has(group.parent.id)) {
					exiting.set(group.parent.id, { group, index });
				}
			});
		}
		setTrack({ baseline: ready, entered, exiting, groups, scope, signature });
	}
	let rows: PresenceRow<T>[] = groups.map(group => ({
		enter: track.entered.has(group.parent.id),
		exiting: false,
		group,
	}));
	for (let [, { group, index }] of [...track.exiting].sort((a, b) => a[1].index - b[1].index)) {
		if (rows.some(row => row.group.parent.id === group.parent.id)) continue;
		rows.splice(Math.min(index, rows.length), 0, { enter: false, exiting: true, group });
	}
	return {
		finish(id: string) {
			setTrack(current => {
				if (!current.exiting.has(id)) return current;
				let exiting = new Map(current.exiting);
				exiting.delete(id);
				return { ...current, exiting };
			});
		},
		rows,
	};
}
