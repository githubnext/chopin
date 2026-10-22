import { useSyncExternalStore } from "react";
import { type Decision, findPlan, type Message, type PlanStatus, type Task } from "./plans";

export type Tab = "plan" | "decisions" | "build";

export type Activity = { login: string; text: string } | null;

export type Cursor = { login: string; pos: number } | null;

export type PlanState = {
	body: string;
	status: PlanStatus;
	tab: Tab;
	messages: Message[];
	composer: string;
	decisions: Decision[];
	tasks: Task[];
	viewers: string[];
	activity: Activity;
	cursor: Cursor;
	updated: string;
	updatedBy: string;
};

export type PlanStore = {
	get: () => PlanState;
	set: (patch: Partial<PlanState> | ((state: PlanState) => Partial<PlanState>)) => void;
	reset: () => void;
	subscribe: (listener: () => void) => () => void;
};

function initial(slug: string): PlanState {
	let plan = findPlan(slug);
	if (!plan) throw new Error(`Unknown plan ${slug}`);
	return {
		body: plan.body,
		status: plan.status,
		tab: "plan",
		messages: plan.messages,
		composer: "",
		decisions: plan.decisions,
		tasks: plan.tasks,
		viewers: ["monalisa"],
		activity: null,
		cursor: null,
		updated: plan.updated,
		updatedBy: plan.updatedBy,
	};
}

let stores = new Map<string, PlanStore>();

export function planStore(slug: string): PlanStore {
	let existing = stores.get(slug);
	if (existing) return existing;
	let state = initial(slug);
	let listeners = new Set<() => void>();
	let emit = () => {
		for (let listener of listeners) listener();
	};
	let store: PlanStore = {
		get: () => state,
		set: patch => {
			let next = typeof patch === "function" ? patch(state) : patch;
			state = { ...state, ...next };
			emit();
		},
		reset: () => {
			state = initial(slug);
			emit();
		},
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	stores.set(slug, store);
	return store;
}

export function usePlanState(store: PlanStore) {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function openDecisions(state: PlanState) {
	return state.decisions.filter(decision => !decision.answer).length;
}
