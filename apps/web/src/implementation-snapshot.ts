import { useEffect, useRef, useState } from "react";

import { ApiError } from "./api";

import type { ImplementationSnapshot } from "@chopin/protocol/implementation";
import type { Wire } from "./wire";

export async function implementationResponse<T>(result: Response): Promise<T> {
	let value = await result.json();
	if (!result.ok) throw new ApiError(value.error ?? "Build is unavailable", result.status);
	return value;
}

/** Full snapshots are needed only while an implementation view is open. */
export function useImplementationSnapshot({ active, room, wire, onLoad }: {
	active: boolean;
	room: string;
	wire?: Wire;
	onLoad: (snapshot: ImplementationSnapshot) => void;
}) {
	let endpoint = `/api/channels/${encodeURIComponent(room)}/implementation`;
	let [loaded, setLoaded] = useState<{ room: string; value: ImplementationSnapshot }>();
	let [loadError, setLoadError] = useState<string>();
	let [revision, setRevision] = useState(0);
	let request = useRef<AbortController | undefined>(undefined);
	let latest = useRef(loaded);
	let received = useRef(onLoad);
	received.current = onLoad;
	let refresh = () => {
		// Invalidate immediately, before React commits the next request's effect.
		request.current?.abort();
		setRevision(value => value + 1);
	};
	useEffect(() => {
		if (!active) return;
		let controller = new AbortController();
		request.current = controller;
		void (async () => {
			try {
				let value = await implementationResponse<ImplementationSnapshot>(
					await fetch(endpoint, { signal: controller.signal, cache: "no-store" }),
				);
				if (controller.signal.aborted) return;
				if (latest.current?.room === room && latest.current.value.revision > value.revision) return;
				latest.current = { room, value };
				setLoaded(latest.current);
				setLoadError(undefined);
				received.current(value);
			} catch (error) {
				if (controller.signal.aborted) return;
				setLoadError(error instanceof Error ? error.message : "Connection failed");
			}
		})();
		return () => controller.abort();
	}, [active, endpoint, room, wire, revision]);
	useEffect(() => {
		if (!active) return;
		let off = ["plan:implementation", "plan:open", "plan:update", "experiment:changed"]
			.map(kind => wire?.on(kind, refresh));
		return () => off.forEach(remove => remove?.());
	}, [active, wire]);
	return {
		snapshot: loaded?.room === room ? loaded.value : undefined,
		loadError,
		refresh,
		endpoint,
	};
}
