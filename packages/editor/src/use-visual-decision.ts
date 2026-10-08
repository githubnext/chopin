import { useEffect, useRef, useSyncExternalStore } from "react";

import { VisualDecisionController } from "./visual-decision-controller";

import type { Transport } from "@chopin/question/react";
import type { Transport as EditorTransport } from "./transport";

let controllers = new WeakMap<Transport, Map<string, VisualDecisionController>>();

export function useVisualDecision(id: string, wire: Transport | undefined, connected: boolean) {
	let holder = useRef<{ wire?: Transport; id: string; controller: VisualDecisionController }>(
		undefined,
	);
	if (!holder.current || holder.current.wire !== wire || holder.current.id !== id) {
		let scoped = wire && controllers.get(wire);
		if (wire && !scoped) controllers.set(wire, scoped = new Map());
		let controller = scoped?.get(id);
		if (!controller) {
			controller = new VisualDecisionController(wire as EditorTransport | undefined, id);
			scoped?.set(id, controller);
		}
		holder.current = { wire, id, controller };
	}
	let controller = holder.current.controller;
	let snapshot = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);
	useEffect(() => {
		controller.configure(connected);
	}, [connected, controller]);
	return {
		...snapshot,
		change: controller.change,
		reset: controller.reset,
		save: controller.save,
		retry: controller.retry,
	};
}
