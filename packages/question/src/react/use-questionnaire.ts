/**
 * The collaborative side of a questionnaire.
 *
 * A questionnaire may be visible in the chat dock and the Plan sidecar at the
 * same time. Those are two views of one answer, not two forms: one controller
 * per Bridge + id owns the CRDT model, revision, outbox, listeners and terminal
 * operations, while hooks are lightweight subscribers to it.
 *
 * Transport is structural rather than imported so this package remains free
 * of the Bridge implementation and the controller stays testable with a stub.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { FocusReporter, QuestionnaireController } from "./questionnaire-controller";
import type { Definition } from "../index";
import type { QuestionnaireState, Transport } from "./questionnaire-types";

export { FocusReporter, QuestionnaireController };
export type { QuestionnaireState, Transport } from "./questionnaire-types";

const controllers = new WeakMap<Transport, Map<string, QuestionnaireController>>();

function shared(
	bridge: Transport,
	id: string,
	definition: Definition | undefined,
	connected: boolean,
): QuestionnaireController {
	let scoped = controllers.get(bridge);
	if (!scoped) controllers.set(bridge, scoped = new Map());
	let controller = scoped.get(id);
	if (!controller) {
		controller = new QuestionnaireController(bridge, id, definition, connected);
		scoped.set(id, controller);
	}
	return controller;
}

export function forget(bridge: Transport, id: string): void {
	let scoped = controllers.get(bridge);
	let controller = scoped?.get(id);
	scoped?.delete(id);
	// Closing notifies mounted subscribers synchronously. Evict first so a
	// subscriber that renders during that notification sees the new controller.
	controller?.forget();
}

export type QuestionnaireOptions = {
	id: string;
	bridge: Transport | undefined;
	connected: boolean;
	definition?: Definition;
};

export function useQuestionnaire(options: QuestionnaireOptions): QuestionnaireState {
	let holder = useRef<{
		bridge: Transport | undefined;
		id: string;
		controller: QuestionnaireController;
	}>(undefined);
	let current = options.bridge
		? shared(options.bridge, options.id, options.definition, options.connected)
		: undefined;

	if (
		!holder.current || holder.current.bridge !== options.bridge || holder.current.id !== options.id
		|| (current && holder.current.controller !== current)
	) {
		holder.current = {
			bridge: options.bridge,
			id: options.id,
			controller: current
				?? new QuestionnaireController(undefined, options.id, options.definition, false),
		};
	}

	let controller = holder.current.controller;
	let snapshot = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	);

	useEffect(() => {
		controller.configure(options.definition, options.connected);
	}, [controller, options.connected, options.definition]);

	return {
		definition: snapshot.definition,
		drafts: snapshot.drafts,
		collaborators: snapshot.collaborators,
		syncing: snapshot.syncing,
		submitting: snapshot.submitting,
		error: snapshot.error,
		focus: snapshot.focus,
		change: controller.change,
		focusQuestion: controller.focusQuestion,
		addOption: controller.addOption,
		submit: controller.submit,
		discard: controller.discard,
		reopen: controller.reopen,
		cancel: controller.cancel,
	};
}
