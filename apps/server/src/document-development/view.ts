import type { DocumentDevelopment } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { State } from "./state";

export function view(plan: Plan): DocumentDevelopment.State {
	return stateView(plan.documentDevelopment);
}

export function stateView(state: State | undefined): DocumentDevelopment.State {
	return {
		kind: "document-development:state",
		ts: 0,
		...(state?.lastOutcome ? { lastOutcome: state.lastOutcome } : {}),
		paused: state?.paused ?? false,
		pending: !!state?.pending,
		generated: state?.passages.filter(passage => passage.status === "generated").length ?? 0,
		protected: state?.passages.filter(passage => passage.status === "protected").length ?? 0,
	};
}

export function recoveryView(state: State | undefined): DocumentDevelopment.RecoveryState {
	return {
		kind: "document-development:recovery-state",
		ts: 0,
		items: state?.recovery?.retired.flatMap(item =>
			item.version?.status === "pending"
				? [{ id: item.id, digest: item.version.digest, preview: item.version.source.slice(0, 200) }]
				: []
		) ?? [],
	};
}
