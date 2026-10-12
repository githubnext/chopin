import { useEffect, useRef, useState } from "react";

import { implementationEndpoint, implementationResponse } from "./build-start";

import type { ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { Wire } from "./wire";

const RELOAD_ON = ["plan:implementation", "plan:open", "plan:update", "experiment:changed"];

/**
 * Full snapshots are needed only while an implementation view is active. Responses for
 * another room, or older than the snapshot already held, are ignored.
 */
export function useImplementationSnapshot({ active, room, wire, reloadOn = RELOAD_ON }: {
	active: boolean;
	room: string;
	wire?: Wire;
	/** Frames that make the snapshot stale. */
	reloadOn?: string[];
}) {
	let endpoint = implementationEndpoint(room);
	let [loaded, setLoaded] = useState<{ room: string; value: ImplementationSnapshot }>();
	let [loadError, setLoadError] = useState<string>();
	let [revision, setRevision] = useState(0);
	let request = useRef<AbortController | undefined>(undefined);
	let latest = useRef(loaded);
	let currentRoom = useRef(room);
	currentRoom.current = room;
	let refresh = () => {
		// Invalidate immediately, before React commits the next request's effect.
		request.current?.abort();
		setRevision(value => value + 1);
	};
	/** Read the snapshot now; the newest one for this room is kept. */
	let read = async (signal?: AbortSignal) => {
		let value = await implementationResponse<ImplementationSnapshot>(
			await fetch(endpoint, { signal, cache: "no-store" }),
		);
		if (signal?.aborted || currentRoom.current !== room) return value;
		if (latest.current?.room === room && latest.current.value.revision > value.revision) {
			return value;
		}
		latest.current = { room, value };
		setLoaded(latest.current);
		setLoadError(undefined);
		return value;
	};
	useEffect(() => {
		if (!active) return;
		let controller = new AbortController();
		request.current = controller;
		read(controller.signal).catch(error => {
			if (controller.signal.aborted) return;
			setLoadError(error instanceof Error ? error.message : "Connection failed");
		});
		return () => controller.abort();
	}, [active, endpoint, revision]);
	useEffect(() => {
		if (!active) return;
		let off = reloadOn.map(kind => wire?.on(kind, refresh));
		return () => off.forEach(remove => remove?.());
	}, [active, wire]);
	return {
		snapshot: loaded?.room === room ? loaded.value : undefined,
		loadError,
		refresh,
		read,
	};
}
