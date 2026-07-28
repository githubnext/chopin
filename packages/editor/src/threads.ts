/**
 * Which comment threads the plan holds, and where they point.
 *
 * Two sources feed this and they arrive separately on purpose. What a thread
 * says comes over `comment:*`; where it points comes over `plan:anchors`, with
 * every other relationship in the plan, because a passage moves whenever the
 * document does. Joining them by id here is what keeps the server from having
 * to send the same fact twice on two schedules.
 *
 * An external store rather than React state because resolution has to re-run
 * on every editor update, and that update arrives from a Lexical listener which
 * knows nothing about rendering.
 */

import { useCallback, useSyncExternalStore } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";

import { resolve } from "./anchors";
import { clear as unpaint, paint } from "./marks";
import { $recover, locate } from "./passage";

import type { Binding } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";
import type { Comment, Plan } from "@chopin/protocol";
import type { Marked, Tone } from "./marks";
import type { Marked as Selected, Points } from "./passage";
import type { Transport } from "./transport";

/** A thread being written but not yet sent. It has no id until the server gives it one. */
export type Draft = Selected;

export type ThreadView = {
	thread: Comment.Thread;
	/** Where it points, once the anchors snapshot has caught up. */
	points?: Points;
	/** The passage cannot be found: the prose it marked has changed. */
	drifted: boolean;
	/**
	 * The agent has said what an accepted thread produced.
	 *
	 * Derived from the result anchor rather than tracked: `pending` already
	 * means "nobody has reviewed this since the last change", which is exactly
	 * the question the card is asking.
	 */
	applied: boolean;
	/** The prose it marks, as it currently reads. Frozen once resolved. */
	quote: string;
	/** Position in the document, for ordering the pane. Undefined if unresolved. */
	at?: number;
};

export type ThreadState = {
	threads: ThreadView[];
	draft?: Draft;
	/** Who is writing a reply, by thread. */
	writing: { [thread: string]: string[] };
	focused?: string;
	/** Why the last attempt to mark a passage was refused. */
	error?: string;
};

const EMPTY: ThreadState = { threads: [], writing: {} };

export class ThreadStore {
	#state: ThreadState = EMPTY;
	#listeners = new Set<() => void>();

	#threads = new Map<string, Comment.Thread>();
	#anchors = new Map<string, Plan.ThreadAnchors>();
	#writing = new Map<string, Map<string, string>>();
	#draft: Draft | undefined;
	#focused: string | undefined;
	#error: string | undefined;

	#binding: Binding | undefined;
	#editor: LexicalEditor | undefined;
	#wire: Transport | undefined;

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	snapshot = (): ThreadState => this.#state;

	attach(editor: LexicalEditor | undefined): void {
		this.#editor = editor;
		if (!editor) unpaint();
	}

	bind(binding: Binding | undefined): void {
		this.#binding = binding;
	}

	/**
	 * Take the room's socket, and listen on it.
	 *
	 * Returns the disposer rather than owning the lifetime: the host knows when
	 * the connection goes away, and a store that unsubscribed itself would have
	 * to guess.
	 */
	listen(wire: Transport | undefined): () => void {
		this.#wire = wire;
		if (!wire) {
			this.#threads.clear();
			this.refresh();
			return () => {};
		}

		let off = [
			wire.on<Comment.Sync>("comment:sync", frame => this.sync(frame.threads)),
			wire.on<Comment.Opened>("comment:opened", frame => this.opened(frame.thread)),
			wire.on<Comment.Said>("comment:said", frame => this.said(frame.id, frame.note)),
			wire.on<Comment.Resolved>("comment:resolved", frame => this.resolved(frame)),
			wire.on<Comment.Typing.Output>("comment:typing", frame => this.typing(frame)),
		];

		return () => {
			for (let stop of off) stop();
			this.#wire = undefined;
		};
	}

	// -- acting ----------------------------------------------------------------

	/** Send the drafted comment. The thread arrives back as `comment:opened`. */
	start(text: string): void {
		let draft = this.#draft;
		if (!draft || !this.#wire) return;

		void this.#wire
			.ask<Comment.Start.Reply>("comment:start", { ...draft, text })
			.then(frame => {
				if (frame.ok) return this.opened(frame.thread);
				// The plan moved under the selection, or there are too many
				// open threads. Either way the draft is no longer sendable.
				this.#draft = undefined;
				this.#error = frame.message;
				this.refresh();
			})
			.catch(() => {});
	}

	reply(id: string, text: string): void {
		void this.#wire
			?.ask<Comment.Reply.Reply>("comment:reply", { id, text })
			.then(frame => {
				if (frame.ok) this.said(id, frame.note);
			})
			.catch(() => {});
	}

	accept(id: string): void {
		void this.#wire?.ask("comment:accept", { id }).catch(() => {});
	}

	dismiss(id: string): void {
		void this.#wire?.ask("comment:dismiss", { id }).catch(() => {});
	}

	/**
	 * Ask the agent to have another go at an accepted thread.
	 *
	 * An ordinary chat message, because that is what it is: the decision was
	 * already made and recorded, and what is missing is a turn. Inventing a
	 * frame for "run that again" would be a second way to start one.
	 */
	retry(id: string): void {
		let view = this.#state.threads.find(entry => entry.thread.id === id);
		if (!view || !this.#wire) return;
		this.#wire.send("chat:send", {
			text: `@ai apply the accepted comment on "${view.quote}" — it has not been actioned yet.`,
		});
	}

	announce(id: string, writing: boolean): void {
		this.#wire?.send("comment:typing", { id, writing });
	}

	// -- what threads say ------------------------------------------------------

	/** Replace everything, from `comment:sync`. */
	sync(threads: Comment.Thread[]): void {
		this.#threads = new Map(threads.map(thread => [thread.id, thread]));
		this.refresh();
	}

	opened(thread: Comment.Thread): void {
		this.#threads.set(thread.id, thread);
		// The card that was being drafted is now a real thread.
		this.#draft = undefined;
		this.refresh();
	}

	said(id: string, note: Comment.Note): void {
		let thread = this.#threads.get(id);
		if (!thread) return;
		// A note the sender already added, arriving as a broadcast, must not
		// appear twice.
		if (thread.notes.some(existing => existing.id === note.id)) return;
		this.#threads.set(id, { ...thread, notes: [...thread.notes, note] });
		this.refresh();
	}

	resolved(event: Comment.Resolved): void {
		let thread = this.#threads.get(event.id);
		if (!thread) return;
		this.#threads.set(event.id, {
			...thread,
			status: event.status,
			resolver: event.resolver,
			at: event.at,
			quote: event.quote,
		});
		this.#writing.delete(event.id);
		this.refresh();
	}

	typing(event: Comment.Typing.Output): void {
		let entry = this.#writing.get(event.id);
		if (event.writing) {
			if (!entry) this.#writing.set(event.id, entry = new Map());
			entry.set(event.client, event.handle);
		} else {
			entry?.delete(event.client);
		}
		this.refresh();
	}

	// -- where they point ------------------------------------------------------

	/** Take a new snapshot from the server. */
	anchors(threads: Plan.ThreadAnchors[]): void {
		this.#anchors = new Map(threads.map(entry => [entry.thread, entry]));
		this.refresh();
	}

	// -- drafting --------------------------------------------------------------

	/**
	 * Start a comment on what is selected.
	 *
	 * The passage is captured now, not held as a live selection: clicking into
	 * the composer destroys the selection that summoned it, and a draft that
	 * forgot what it was about the moment you started typing would be useless.
	 */
	draft(value: Draft | undefined): void {
		this.#draft = value;
		this.#error = undefined;
		this.refresh();
	}

	focus(id: string | undefined): void {
		if (this.#focused === id) return;
		this.#focused = id;
		this.refresh();
	}

	/** The thread whose passage covers a point, innermost first. */
	at(node: Node, offset: number): string | undefined {
		let editor = this.#editor;
		if (!editor) return undefined;

		let best: { id: string; length: number } | undefined;
		for (let view of this.#state.threads) {
			if (!view.points) continue;
			let range = domRange(editor, view.points);
			if (!range) continue;
			try {
				if (range.comparePoint(node, offset) !== 0) continue;
			} catch {
				continue;
			}
			let length = range.toString().length;
			// The tighter range is the more specific thing that was clicked;
			// the list is in document order, so a later tie is the newer thread.
			if (!best || length <= best.length) best = { id: view.thread.id, length };
		}

		return best?.id;
	}

	/**
	 * Re-resolve and repaint.
	 *
	 * Called on every editor update as well as on new data, because a passage
	 * is expressed against the document and any edit can move it.
	 *
	 * Guarded as a whole, on top of the per-thread guard inside. This runs as a
	 * Lexical update listener, and Lexical runs those in one loop with no
	 * isolation: the first to throw skips every listener after it, including
	 * the one that syncs the document. A comment failing to paint must not cost
	 * the room its collaboration.
	 */
	refresh = (): void => {
		try {
			this.#rebuild();
		} catch (err) {
			console.error("[plan] could not refresh the comment sidecar:", err);
		}
	};

	#rebuild(): void {
		let editor = this.#editor;
		let binding = this.#binding;

		let views: ThreadView[] = [];
		let marks: Marked[] = [];

		// Dismissed threads are not shown at all — the transcript is where they
		// left their trace — so they are dropped once here rather than in each
		// branch below, where one copy of the rule could outlive the other.
		let live = [...this.#threads.values()].filter(thread => thread.status !== "dismissed");

		let build = () => {
			for (let thread of live) {
				/*
				 * One thread at a time, and the whole of it.
				 *
				 * A thread whose relationship cannot be read is a highlight
				 * nobody gets, not a sidecar nobody gets — and certainly not a
				 * document nobody gets. The card still renders with its quote
				 * and its notes, which is the durable part of a comment; the
				 * anchor was only ever a convenience for finding it again.
				 *
				 * The guard covers reading the snapshot as well as resolving
				 * it, because a malformed entry is as likely as an unresolvable
				 * one and would otherwise cost every other card too.
				 */
				try {
					let anchors = this.#anchors.get(thread.id);
					// Nothing resolves before the editor exists; the card still
					// renders, with the quote and no highlight.
					let points = editor && binding && anchors
						? this.#points(binding, anchors)
						: undefined;

					views.push({
						thread,
						...(points ? { points } : {}),
						drifted: !!anchors?.subject.drifted || (!!editor && !!anchors && !points),
						applied: !!anchors && !anchors.result.pending,
						quote: thread.quote ?? anchors?.subject.quote ?? "",
						...(points && editor ? { at: order(editor, points.anchorKey) } : {}),
					});

					if (points) marks.push({ tone: this.#tone(thread), points });
				} catch (err) {
					console.error(`[plan] could not place comment ${thread.id}:`, err);
					// Unplaceable, but still worth reading.
					views.push({
						thread,
						drifted: true,
						applied: false,
						quote: thread.quote ?? "",
					});
				}
			}
		};

		if (editor && binding) editor.getEditorState().read(build);
		else build();

		views.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
		if (editor) paint(editor, marks);

		let writing: { [thread: string]: string[] } = {};
		for (let [id, entry] of this.#writing) {
			if (entry.size > 0) writing[id] = [...new Set(entry.values())];
		}

		let next: ThreadState = {
			threads: views,
			writing,
			...(this.#draft ? { draft: this.#draft } : {}),
			...(this.#focused ? { focused: this.#focused } : {}),
			...(this.#error ? { error: this.#error } : {}),
		};

		// Every keystroke in the plan produces an update and almost none of
		// them move a thread. Comparing before publishing is what keeps the
		// pane from re-rendering on every character typed in the prose.
		if (JSON.stringify(next) === JSON.stringify(this.#state)) return;
		this.#state = next;
		for (let listener of this.#listeners) listener();
	}

	#tone(thread: Comment.Thread): Tone {
		if (this.#focused === thread.id) return "current";
		return thread.status === "accepted" ? "decided" : "open";
	}

	/** Positions first; reading is what covers the gap before the next rebase. */
	#points(binding: Binding, anchors: Plan.ThreadAnchors): Points | undefined {
		let found = locate(binding, anchors.subject);
		if (found) return found;

		let keys = anchors.subject.blocks
			.map(block => resolve(binding, block))
			.filter((key): key is string => !!key);
		if (keys.length !== anchors.subject.blocks.length) return undefined;

		return $recover(anchors.subject, keys);
	}
}

/** Where a node sits among the document's blocks, for ordering the pane. */
function order(editor: LexicalEditor, key: string): number | undefined {
	let element = editor.getElementByKey(key);
	if (!element) return undefined;

	let root = editor.getRootElement();
	if (!root) return undefined;

	let block = element.closest(".plan-content > *") ?? element;
	let index = [...root.children].indexOf(block);
	return index === -1 ? undefined : index;
}

function domRange(editor: LexicalEditor, points: Points): Range | undefined {
	let anchor = editor.getElementByKey(points.anchorKey);
	let focus = editor.getElementByKey(points.focusKey);
	if (!anchor || !focus) return undefined;

	let range = document.createRange();
	try {
		range.setStart(anchor.firstChild ?? anchor, points.anchorOffset);
		range.setEnd(focus.firstChild ?? focus, points.focusOffset);
	} catch {
		return undefined;
	}
	return range;
}

/** Mounted inside the editor, so resolution re-runs as the document changes. */
export function ThreadObserver({ store }: { store: ThreadStore }) {
	let [editor] = useLexicalComposerContext();

	useEffect(() => {
		store.attach(editor);
		store.refresh();
		let off = editor.registerUpdateListener(store.refresh);
		return () => {
			off();
			store.attach(undefined);
		};
	}, [editor, store]);

	return null;
}

export function useThreads(store: ThreadStore): ThreadState {
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	return useSyncExternalStore(subscribe, store.snapshot, store.snapshot);
}
