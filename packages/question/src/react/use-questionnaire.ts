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

import { derive } from "../answer";
import { crdt } from "../draft";
import { decision } from "../schema";

import type { DecisionDefinition, Definition, Drafts } from "../index";
import type { Collaborator } from "./question-view";

type Unsubscribe = () => void;

/** The slice of the Bridge this needs. */
export type Transport = {
	ask<K extends string>(kind: K, payload: Record<string, unknown>): Promise<never>;
	send(kind: string, payload: Record<string, unknown>): void;
	on(kind: string, handler: (event: never) => void): Unsubscribe;
};

export type QuestionnaireState = {
	definition: Definition | undefined;
	drafts: Drafts;
	collaborators: Collaborator[];
	/** True until the shared draft has arrived. */
	syncing: boolean;
	submitting: boolean;
	/** Validation or synchronisation problem, shown to the user. */
	error: string | undefined;
	change: (question: string, change: Record<string, unknown>) => void;
	submit: () => void;
	/** Decline to answer. Terminal — the agent stops waiting. */
	cancel: () => void;
	/** Set when submission stopped on an unanswered question. */
	focus: string | undefined;
};

type Snapshot = Omit<QuestionnaireState, "change" | "submit" | "cancel"> & {
	closed: boolean;
};
type Model = crdt.Model<crdt.JsonNode<Drafts>>;

const EMPTY_DRAFTS: Drafts = Object.freeze({});
const controllers = new WeakMap<Transport, Map<string, QuestionnaireController>>();

function normalize(person: {
	client: string;
	handle?: string;
	question?: string;
}): Collaborator {
	return {
		client: person.client,
		handle: person.handle ?? "unknown",
		...(person.question ? { question: person.question } : {}),
	};
}

export class QuestionnaireController {
	readonly id: string;
	readonly bridge: Transport | undefined;

	#snapshot: Snapshot;
	#listeners = new Set<() => void>();
	#teardown: Unsubscribe[] = [];
	#model: Model | undefined;
	#definition: DecisionDefinition | undefined;
	#revision = 0;
	#outbox: number[][] = [];
	#pending = Promise.resolve();
	#generation = 0;
	#refs = 0;
	#connected: boolean;
	#active = false;
	#terminal = false;

	constructor(
		bridge: Transport | undefined,
		id: string,
		definition: Definition | undefined,
		connected: boolean,
	) {
		this.bridge = bridge;
		this.id = id;
		this.#connected = connected;
		this.#snapshot = {
			definition,
			drafts: EMPTY_DRAFTS,
			collaborators: [],
			syncing: !!bridge,
			submitting: false,
			error: undefined,
			focus: undefined,
			closed: false,
		};
	}

	getSnapshot = (): Snapshot => this.#snapshot;

	subscribe = (listener: () => void): Unsubscribe => {
		this.#listeners.add(listener);
		this.#refs++;
		if (this.#refs === 1) this.#start();

		return () => {
			this.#listeners.delete(listener);
			this.#refs--;
			// React Strict Mode subscribes, cleans up, then subscribes again. A
			// microtask grace period turns that into one transport lifecycle rather
			// than two opens with a spurious presence clear between them.
			if (this.#refs === 0) {
				queueMicrotask(() => {
					if (this.#refs === 0) this.#stop(true);
				});
			}
		};
	};

	configure(definition: Definition | undefined, connected: boolean): void {
		if (definition && !this.#snapshot.definition) this.#set({ definition });
		if (connected === this.#connected) return;
		this.#connected = connected;
		if (!connected) {
			this.#stop(false);
			this.#set({ syncing: !!this.bridge, collaborators: [] });
		} else if (this.#refs > 0) {
			this.#start();
		}
	}

	change = (question: string, patch: Record<string, unknown>): void => {
		let doc = this.#model;
		if (!doc || this.#snapshot.closed || this.#terminal || this.#snapshot.submitting) return;
		this.#set({ error: undefined, focus: undefined });

		doc.api.transaction(() => {
			if (patch.mode !== undefined) doc.api.val([question, "mode"]).set(patch.mode);
			if (patch.choice !== undefined) {
				doc.api.val([question, "mode"]).set("choices");
				doc.api.val([question, "choice"]).set(patch.choice);
			}
			if (patch.options !== undefined) {
				doc.api.val([question, "mode"]).set("choices");
				for (let [option, value] of Object.entries(patch.options as Record<string, boolean>)) {
					doc.api.val([question, "options", option]).set(value);
				}
			}
			if (patch.custom !== undefined) {
				let value = doc.api.str([question, "custom"]);
				value.del(0, value.length());
				value.ins(0, patch.custom as string);
			}
		});
	};

	submit = (): void => {
		let definition = this.#definition;
		let doc = this.#model;
		if (
			!this.bridge || !definition || !doc || this.#snapshot.closed || this.#terminal
			|| this.#snapshot.submitting
		) return;

		let outcome = derive(definition, doc.view() as Drafts);
		if (!outcome.ok) {
			this.#set({
				focus: outcome.question,
				error: outcome.message,
			});
			return;
		}

		this.#terminal = true;
		this.#set({ submitting: true, error: undefined });
		let submit = async () => {
			// The CRDT batches its change callback into a microtask. Let the final
			// input event enter the outbox before choosing the revision to submit.
			await Promise.resolve();
			await this.#pending;
			if (this.#outbox.length > 0) throw new Error("questionnaire edits are not synchronized");
			return this.bridge!.ask("question:submit", { id: this.id, revision: this.#revision });
		};
		void submit()
			.then((raw: never) => {
				let reply = raw as unknown as { ok?: boolean; reason?: string; message?: string };
				if (reply.ok) return;
				if (reply.reason === "stale") {
					this.#terminal = false;
					this.#set({ error: "Answers changed while submitting. Review and try again." });
					this.#restart();
				} else if (reply.reason === "resolved") {
					this.#close();
				} else {
					this.#terminal = false;
					this.#set({ error: reply.message ?? "Could not submit these answers." });
				}
			})
			.catch(() => {
				this.#terminal = false;
				this.#set({ error: "Could not submit these answers." });
			})
			.finally(() => {
				if (!this.#terminal) this.#set({ submitting: false });
			});
	};

	cancel = (): void => {
		if (!this.bridge || this.#snapshot.closed || this.#terminal || this.#snapshot.submitting) {
			return;
		}
		this.#terminal = true;
		this.#set({ submitting: true, error: undefined });

		void this.bridge.ask("question:cancel", { id: this.id })
			.then((raw: never) => {
				let reply = raw as unknown as { ok?: boolean; reason?: string };
				if (reply.ok || reply.reason === "resolved") this.#close();
				else {
					this.#terminal = false;
					this.#set({ error: "Could not cancel this question." });
				}
			})
			.catch(() => {
				this.#terminal = false;
				this.#set({ error: "Could not cancel this question." });
			})
			.finally(() => {
				if (!this.#terminal) this.#set({ submitting: false });
			});
	};

	forget(): void {
		this.#close();
	}

	#set(patch: Partial<Snapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (let listener of this.#listeners) listener();
	}

	#start(): void {
		if (this.#active || !this.bridge || !this.#connected || this.#snapshot.closed) return;
		this.#active = true;
		void this.#init(++this.#generation);
	}

	#restart(): void {
		this.#stop(false);
		if (this.#refs > 0) this.#start();
	}

	#stop(presence: boolean): void {
		if (!this.#active) return;
		this.#active = false;
		this.#generation++;
		for (let off of this.#teardown.splice(0)) off();
		this.#model = undefined;
		this.#definition = undefined;
		if (presence && this.bridge && this.#connected) {
			this.bridge.send("question:presence", { id: this.id });
		}
	}

	#close(): void {
		this.#terminal = true;
		this.#outbox = [];
		this.#set({ closed: true, syncing: false, submitting: false, collaborators: [] });
		this.#stop(false);
	}

	async #init(generation: number): Promise<void> {
		let channel = this.bridge!;
		this.#set({ syncing: true, error: undefined });

		let buffered: number[][] = [];
		let apply: ((patch: number[]) => void) | undefined;

		this.#teardown.push(
			channel.on("question:edit", (raw: never) => {
				let event = raw as unknown as {
					id: string;
					open?: boolean;
					accepted?: boolean;
					applied?: boolean;
					revision: number;
					patch: number[];
				};
				if (event.id !== this.id || !event.open || !event.accepted) return;
				this.#revision = Math.max(this.#revision, event.revision);
				if (!event.applied) return;
				if (apply) apply(event.patch);
				else buffered.push(event.patch);
			}),
			channel.on("question:presence", (raw: never) => {
				let event = raw as unknown as {
					id: string;
					client: string;
					handle?: string;
					question?: string;
				};
				if (event.id !== this.id) return;
				let person = normalize(event);
				let next = this.#snapshot.collaborators.filter(item => item.client !== person.client);
				this.#set({ collaborators: event.question ? [...next, person] : next });
			}),
			channel.on("question:resolved", (raw: never) => {
				let event = raw as unknown as { id: string };
				if (event.id === this.id) this.#close();
			}),
		);

		let reply: {
			open: boolean;
			definition?: Definition;
			model?: number[];
			revision?: number;
			presence?: Array<{
				client: string;
				handle?: string;
				question?: string;
			}>;
		};

		try {
			reply = await channel.ask("question:open", { id: this.id }) as never;
		} catch {
			if (!this.#valid(generation)) return;
			this.#set({ error: "Unable to sync shared answers." });
			return;
		}

		if (!this.#valid(generation)) return;
		if (!reply.open) return this.#close();
		let definition: DecisionDefinition;
		try {
			definition = decision(reply.definition!);
		} catch {
			this.#set({ syncing: false, error: "Unable to sync shared answers." });
			return;
		}

		let doc = crdt.Model
			.fromBinary<crdt.JsonNode<Drafts>>(new Uint8Array(reply.model!))
			.fork();

		this.#revision = Math.max(this.#revision, reply.revision ?? 0);
		apply = patch => {
			doc.applyPatch(crdt.Patch.fromBinary(new Uint8Array(patch)));
			this.#set({ drafts: doc.view() as Drafts });
		};
		for (let patch of buffered) apply(patch);
		for (let patch of this.#outbox) apply(patch);

		let send = (patch: number[]) => {
			this.#pending = this.#pending.then(() =>
				channel.ask("question:edit", { id: this.id, patch })
					.then((raw: never) => {
						let ack = raw as unknown as {
							open?: boolean;
							accepted?: boolean;
							revision?: number;
							message?: string;
						};
						let index = this.#outbox.indexOf(patch);
						if (index !== -1) this.#outbox.splice(index, 1);
						if (!ack.open) return this.#close();
						if (!ack.accepted) {
							this.#set({
								error: `${ack.message ?? "An edit was rejected"}. Syncing latest answers.`,
							});
							this.#restart();
							return;
						}
						this.#revision = Math.max(this.#revision, ack.revision ?? 0);
					})
					.catch(() => {
						// Left in the outbox for the next successful open.
					})
			);
		};

		let offChanges = doc.api.onChanges.listen(() => {
			this.#set({ drafts: doc.view() as Drafts });
			let patch = doc.api.flush();
			if (patch.ops.length === 0) return;
			let binary = Array.from(patch.toBinary() as Uint8Array);
			this.#outbox.push(binary);
			send(binary);
		});

		this.#teardown.push(offChanges);
		this.#model = doc;
		this.#definition = definition;
		for (let patch of this.#outbox) send(patch);

		this.#set({
			definition,
			drafts: doc.view() as Drafts,
			collaborators: (reply.presence ?? []).map(normalize),
			syncing: false,
			error: undefined,
		});
	}

	#valid(generation: number): boolean {
		return this.#active && this.#generation === generation;
	}
}

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

/** Evict terminal state so an explicitly reused request id starts cleanly. */
export function forget(bridge: Transport, id: string): void {
	let scoped = controllers.get(bridge);
	let controller = scoped?.get(id);
	controller?.forget();
	scoped?.delete(id);
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

	if (
		!holder.current || holder.current.bridge !== options.bridge || holder.current.id !== options.id
	) {
		holder.current = {
			bridge: options.bridge,
			id: options.id,
			controller: options.bridge
				? shared(options.bridge, options.id, options.definition, options.connected)
				: new QuestionnaireController(undefined, options.id, options.definition, false),
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
		submit: controller.submit,
		cancel: controller.cancel,
	};
}
