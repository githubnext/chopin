import { derive } from "../answer";
import { crdt } from "../draft";
import { decision, identified } from "../schema";
import type { Definition, Drafts } from "../index";
import type { AddOptionResult, Collaborator } from "./question-view";
import type { Snapshot, Transport, Unsubscribe } from "./questionnaire-types";

type Model = crdt.Model<crdt.JsonNode<Drafts>>;

const EMPTY_DRAFTS: Drafts = Object.freeze({});

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

/**
 * Says which question this connection is working on, once per change.
 *
 * Focus moves between questions, not keystrokes, so deduping against what the
 * server last heard is all the throttling needed. The wanted question survives
 * a reconnect and is resent when the draft reopens.
 */
export class FocusReporter {
	#wanted: string | undefined;
	#sent: string | undefined;
	#online = false;

	constructor(private readonly send: (question: string | undefined) => void) {}

	set(question: string | undefined): void {
		this.#wanted = question;
		this.#flush();
	}

	/** The draft is open (true) or gone (false); the server forgets us when it is gone. */
	online(online: boolean): void {
		this.#online = online;
		this.#sent = undefined;
		this.#flush();
	}

	#flush(): void {
		if (!this.#online || this.#wanted === this.#sent) return;
		this.#sent = this.#wanted;
		this.send(this.#wanted);
	}
}

export class QuestionnaireController {
	readonly id: string;
	readonly bridge: Transport | undefined;

	#snapshot: Snapshot;
	#listeners = new Set<() => void>();
	#teardown: Unsubscribe[] = [];
	#model: Model | undefined;
	#definition: Definition | undefined;
	#revision = 0;
	#outbox: number[][] = [];
	#pending = Promise.resolve();
	#opening: Promise<void> = Promise.resolve();
	#generationWaiters = new Set<() => void>();
	#generation = 0;
	#refs = 0;
	#connected: boolean;
	#active = false;
	#terminal = false;
	#focus = new FocusReporter(question => {
		this.bridge?.send("question:presence", { id: this.id, question });
	});
	#adding: { question: string; label: string; key: string } | undefined;

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
				queueMicrotask(() => this.#stopIfUnobserved());
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
				let held = (doc.view() as Drafts)[question]?.options ?? {};
				for (let [option, value] of Object.entries(patch.options as Record<string, boolean>)) {
					// An option appended after this draft began has no register yet.
					if (Object.hasOwn(held, option)) doc.api.val([question, "options", option]).set(value);
					else {
						doc.api.obj([question, "options"]).set({
							[option]: crdt.schema.val(crdt.schema.con(value)),
						});
					}
				}
			}
			if (patch.custom !== undefined) {
				let value = doc.api.str([question, "custom"]);
				let text = patch.custom as string;
				// json-joy 17 binary-encodes a zero-length delete so that the receiver decodes
				// garbage that swallows the following insert, and it throws on an empty insert.
				if (value.length() > 0) value.del(0, value.length());
				if (text) value.ins(0, text);
			}
		});
	};

	/** Report the question this person is working on; undefined when they leave it. */
	focusQuestion = (question: string | undefined): void => {
		this.#focus.set(this.#terminal ? undefined : question);
	};

	submit = (visibleSuggestion?: { optionId: string; revision: number }): void => {
		let definition = this.#definition;
		let doc = this.#model;
		if (
			!this.bridge || !definition || !doc || this.#snapshot.closed || this.#terminal
			|| this.#snapshot.submitting
		) return;

		let drafts = doc.view() as Drafts;
		let outcome = derive(definition, drafts);
		let suggestion: { optionId: string; revision: number } | undefined;
		if (!outcome.ok && visibleSuggestion) {
			let question = definition.questions[0];
			let draft = question && drafts[question.id];
			if (
				definition.questions.length === 1 && question && !question.multiple && draft
				&& draft.mode === "choices" && draft.choice === null && draft.custom.length === 0
				&& !Object.values(draft.options).some(Boolean)
				&& question.options.some(option => option.id === visibleSuggestion.optionId)
				&& Number.isSafeInteger(visibleSuggestion.revision)
			) {
				suggestion = {
					optionId: visibleSuggestion.optionId,
					revision: visibleSuggestion.revision,
				};
				outcome = derive(definition, {
					...drafts,
					[question.id]: { ...draft, choice: suggestion.optionId },
				});
			}
		}
		if (!outcome.ok) {
			this.#set({
				focus: outcome.question,
				error: outcome.message,
			});
			return;
		}

		this.#terminal = true;
		this.#focus.set(undefined);
		this.#set({ submitting: true, error: undefined });
		let submit = async () => {
			// The CRDT batches its change callback into a microtask. Let the final
			// input event enter the outbox before choosing the revision to submit.
			await Promise.resolve();
			while (true) {
				if (this.#snapshot.closed) return;
				if (!this.#active || !this.#connected) {
					throw new Error("questionnaire is disconnected");
				}
				let generation = this.#generation;
				let wake!: () => void;
				let changed = new Promise<void>(resolve => wake = resolve);
				this.#generationWaiters.add(wake);
				try {
					// A definition refresh abandons the old edit queue. Wait for the
					// new open and its replay instead of waiting for an obsolete ack.
					await Promise.race([this.#opening, changed]);
					if (generation !== this.#generation) continue;
					if (this.#snapshot.closed) return;
					if (!this.#model) throw new Error("questionnaire is not synchronized");
					let pending = this.#pending;
					await Promise.race([pending, changed]);
					if (generation !== this.#generation || pending !== this.#pending) continue;
					if (this.#outbox.length > 0) {
						throw new Error("questionnaire edits are not synchronized");
					}
					return this.bridge!.ask("question:submit", {
						id: this.id,
						revision: suggestion?.revision ?? this.#revision,
						...(suggestion ? { suggestedOptionId: suggestion.optionId } : {}),
					});
				} finally {
					this.#generationWaiters.delete(wake);
				}
			}
		};
		void submit()
			.then((raw: unknown) => {
				if (this.#snapshot.closed) return;
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
				if (this.#snapshot.closed) return;
				this.#terminal = false;
				this.#set({ error: "Could not submit these answers." });
			})
			.finally(() => {
				if (!this.#terminal) this.#set({ submitting: false });
				this.#stopIfUnobserved();
			});
	};

	discard = (): void => {
		if (!this.bridge || this.#snapshot.closed || this.#terminal || this.#snapshot.submitting) {
			return;
		}
		this.#terminal = true;
		this.#focus.set(undefined);
		this.#set({ submitting: true, error: undefined });

		void this.bridge.ask("question:discard", { id: this.id })
			.then((raw: never) => {
				let reply = raw as unknown as { ok?: boolean; reason?: string };
				if (reply.ok || reply.reason === "resolved") this.#close();
				else {
					this.#terminal = false;
					this.#set({ error: "Could not discard this decision." });
				}
			})
			.catch(() => {
				this.#terminal = false;
				this.#set({ error: "Could not discard this decision." });
			})
			.finally(() => {
				if (!this.#terminal) this.#set({ submitting: false });
				this.#stopIfUnobserved();
			});
	};

	cancel = (): void => {
		if (!this.bridge || this.#snapshot.closed || this.#terminal || this.#snapshot.submitting) {
			return;
		}
		this.#terminal = true;
		this.#focus.set(undefined);
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
				this.#stopIfUnobserved();
			});
	};

	reopen = async (): Promise<{ ok: true } | { ok: false; message: string }> => {
		if (!this.bridge || !this.#connected) return { ok: false, message: "Not connected." };
		try {
			let reply = await this.bridge.ask("question:reopen", { id: this.id }) as unknown as {
				ok: boolean;
				reason?: string;
			};
			if (reply.ok) return { ok: true };
			return {
				ok: false,
				message: reply.reason === "not-decided"
					? "Only a decided card can be reopened."
					: "Could not reopen it. Try again.",
			};
		} catch {
			return { ok: false, message: "Could not reopen it. Try again." };
		}
	};

	addOption = async (question: string, label: string): Promise<AddOptionResult> => {
		if (!this.bridge || this.#snapshot.closed || this.#terminal) {
			return { ok: false, message: "This question is no longer open." };
		}
		if (!this.#connected) return { ok: false, message: "Reconnect to add an option." };
		// A retry of the same text after a lost reply must not add a second option.
		let last = this.#adding;
		let key = last && last.question === question && last.label === label
			? last.key
			: crypto.randomUUID();
		this.#adding = { question, label, key };

		let reply: {
			ok?: boolean;
			message?: string;
			definition?: Definition;
		};
		try {
			reply = await this.bridge.ask("question:option", {
				id: this.id,
				question,
				key,
				label,
			}) as never;
		} catch {
			return { ok: false, message: "Could not add this option. Try again." };
		}
		if (!reply.ok) return { ok: false, message: reply.message ?? "Could not add this option." };
		this.#adding = undefined;
		if (reply.definition) this.#redefine(reply.definition);
		return { ok: true };
	};

	/** Take the server's definition when it has gained options. */
	#redefine(next: Definition): void {
		let current = this.#definition ?? this.#snapshot.definition;
		let added = next.questions[0]?.options.length ?? 0;
		let held = current?.questions[0]?.options.length ?? 0;
		// Only ever forward: a late duplicate must not erase a newer option.
		if (added <= held) return;
		try {
			let definition = decision(identified(next));
			if (this.#definition) this.#definition = definition;
			this.#set({ definition });
		} catch {
			// A definition the domain rejects is ignored; the next open resyncs.
		}
	}

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
		this.#opening = this.#init(++this.#generation);
	}

	#restart(): void {
		this.#stop(false);
		if (this.#refs > 0 || this.#snapshot.submitting) this.#start();
	}

	#stopIfUnobserved(): void {
		if (this.#refs === 0 && !this.#snapshot.submitting) this.#stop(true);
	}

	#stop(presence: boolean): void {
		if (!this.#active) return;
		this.#active = false;
		this.#generation++;
		for (let wake of this.#generationWaiters) wake();
		this.#generationWaiters.clear();
		for (let off of this.#teardown.splice(0)) off();
		this.#model = undefined;
		this.#definition = undefined;
		this.#focus.online(false);
		if (presence) this.#focus.set(undefined);
		// A previous generation's edit may never answer. New opens replay every
		// unacknowledged patch through their own queue.
		this.#pending = Promise.resolve();
		if (presence && this.bridge && this.#connected) {
			this.bridge.send("question:presence", { id: this.id });
		}
	}

	#close(): void {
		this.#terminal = true;
		this.#focus.set(undefined);
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
			channel.on("question:changed", (raw: never) => {
				let event = raw as unknown as { id: string; definition: Definition };
				if (event.id !== this.id) return;
				this.#set({ definition: event.definition });
				queueMicrotask(() => {
					if (this.#valid(generation)) this.#restart();
				});
			}),
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
			channel.on("question:option-added", (raw: never) => {
				let event = raw as unknown as { id: string; definition?: Definition };
				if (event.id === this.id && event.definition) this.#redefine(event.definition);
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
		let definition: Definition;
		try {
			definition = identified(reply.definition!);
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
			this.#pending = this.#pending.then(() => {
				if (!this.#valid(generation)) return;
				return channel.ask("question:edit", { id: this.id, patch })
					.then((raw: never) => {
						if (!this.#valid(generation)) return;
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
					});
			});
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

		this.#focus.online(true);
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
