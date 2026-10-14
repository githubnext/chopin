import { useEffect, useMemo, useSyncExternalStore } from "react";

import { response } from "./api";

import type { RecommendationSnapshot } from "@chopin/protocol/recommendation";
import type { Wire } from "./wire";

export type ReadyRecommendation = Extract<RecommendationSnapshot, { state: "ready" }>;

const INVALIDATE_ON = [
	"recommendation:changed",
	"session:hello",
	"session:planner",
	"session:channel",
	"plan:open",
	"plan:update",
	"plan:ack",
	"plan:reset",
	"chat:message",
	"question:asked",
	"question:resolved",
	"question:submit",
	"question:cancel",
	"question:discard",
	"question:reopen",
	"question:option-added",
	"experiment:changed",
	"research:changed",
	"plan:implementation",
];

/** A read is tied to its context generation even if a transport ignores cancellation. */
export class RecommendationReader {
	#value: ReadyRecommendation | undefined;
	#listeners = new Set<() => void>();
	#generation = 0;
	#controller: AbortController | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#connected = false;

	constructor(
		private read: (signal: AbortSignal) => Promise<RecommendationSnapshot>,
		private delay = 120,
	) {}

	readonly snapshot = () => this.#value;
	readonly subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	#clear() {
		this.#generation++;
		this.#controller?.abort();
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#value) return;
		this.#value = undefined;
		for (let listener of this.#listeners) listener();
	}

	readonly refresh = () => {
		this.#clear();
		if (!this.#connected) return;
		let generation = this.#generation;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			let controller = new AbortController();
			this.#controller = controller;
			// A failed advisory read waits for a real context change or reconnect.
			void this.read(controller.signal).then(value => {
				if (controller.signal.aborted || generation !== this.#generation) return;
				if (value.state !== "ready") return;
				this.#value = value;
				for (let listener of this.#listeners) listener();
			}).catch(() => {});
		}, this.delay);
	};

	connect(wire: Pick<Wire, "on">) {
		this.#connected = true;
		let off = INVALIDATE_ON.map(kind => wire.on(kind, this.refresh));
		this.refresh();
		return () => {
			this.#connected = false;
			for (let remove of off) remove();
			this.#clear();
		};
	}
}

/** Advice is visible only while this root document has a current, connected read. */
export function useBuildRecommendation({ active, connected, room, wire }: {
	active: boolean;
	connected: boolean;
	room: string;
	wire?: Wire;
}) {
	// A replacement socket cannot render advice read through its predecessor.
	let reader = useMemo(() =>
		new RecommendationReader(signal =>
			response<RecommendationSnapshot>(
				`/api/channels/${encodeURIComponent(room)}/recommendation`,
				{ signal, cache: "no-store" },
			)
		), [room, wire]);
	let snapshot = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
	useEffect(() => {
		if (active && connected && wire) return reader.connect(wire);
	}, [active, connected, reader, wire]);
	return {
		snapshot: active && connected ? snapshot : undefined,
		current: reader.snapshot,
		refresh: reader.refresh,
	};
}
