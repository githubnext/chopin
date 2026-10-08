/**
 * Remote cursor name labels.
 *
 * A label pinned over every caret buries the prose it is pointing at, and a
 * document is read far more often than it is written. So a label briefly
 * introduces a peer on arrival, when they resume after being idle, or when
 * they move to another block. Continued typing does not keep the name up.
 * Pointing at a caret brings its label back.
 *
 * Movement is read back from the caret's own rendered position rather than
 * from awareness. Awareness churns on a renewal timer whether or not anyone
 * moved; the painted position is the only thing that changes exactly when a
 * peer does. Lexical also repaints carets after a remote edit without telling
 * anyone, and that is the path a typing peer takes, so the container is
 * observed instead of waiting for an awareness update that may land before the
 * caret has moved.
 *
 * Activity belongs to the client, not to a caret element: a repaint can hand
 * the client a new element, and the attribute is re-applied to whichever one
 * is current.
 *
 * The agent's label stays up several times as long. A person's caret is one of
 * several and its owner is watching it, so a moment is enough to say who moved
 * where; the agent's arrives unannounced in a document somebody else is
 * reading, and the whole reason it is drawn at all is to say what put it
 * there. Naming it briefly and going quiet answers a question nobody had time
 * to ask.
 */

import type { Binding, Provider } from "@lexical/yjs";
import { $getNodeByKey, $isElementNode } from "lexical";

/** How long a person's name flashes, and how long a pause counts as idle. */
const LINGER = 1500;

/** How long the agent's stays, for the same reason it is louder at all. */
const AGENT_LINGER = 5_000;

/** How near the pointer has to be to a caret to count as pointing at it. */
const REACH = 6;

export type Labels = {
	/** Flashes whoever moved. Call after cursors are painted. */
	sync: () => void;
	dispose: () => void;
};

/*
 * A label above the caret covers the line above it, which is where the
 * local caret is when two people work on adjacent lines. Drop it below
 * instead whenever it would sit on top of the local caret.
 */
function place(caret: HTMLElement) {
	let name = caret.firstElementChild as HTMLElement | null;
	let local = window.getSelection();
	let range = local?.rangeCount ? local.getRangeAt(0) : undefined;
	let rect = range?.getClientRects()[0] ?? range?.getBoundingClientRect();
	if (!name || !rect?.height) return caret.removeAttribute("data-plan-below");
	let box = caret.getBoundingClientRect();
	let covers = rect.right >= box.left - 1 && rect.left <= box.left + name.offsetWidth
		&& rect.bottom >= box.top - name.offsetHeight && rect.top < box.top;
	if (covers) caret.dataset.planBelow = "";
	else caret.removeAttribute("data-plan-below");
}

export function labels(
	binding: Binding,
	provider: Provider,
	linger = LINGER,
	agentLinger = AGENT_LINGER,
): Labels {
	/*
	 * Read from awareness rather than from the cursor, which only carries a
	 * name and a colour. Matching on the name would be the obvious shortcut
	 * and is wrong: handles are GitHub logins, `github.com/ai` is a real
	 * account, and somebody signing in as that would get the agent's chrome.
	 */
	let agent = (client: number): boolean =>
		provider.awareness.getStates().get(client)?.agent === true;

	let caretOf = (client: number): HTMLElement | undefined =>
		binding.cursors.get(client)?.selection?.caret;

	let seen = new Map<number, { at: string; block: string | undefined; active: number }>();
	let timers = new Map<number, ReturnType<typeof setTimeout>>();
	let pointer: { x: number; y: number } | null = null;

	let stop = (client: number) => {
		let timer = timers.get(client);
		if (timer === undefined) return;
		clearTimeout(timer);
		timers.delete(client);
	};

	let forget = (client: number) => {
		seen.delete(client);
		stop(client);
	};

	let point = () => {
		for (let client of binding.cursors.keys()) {
			let caret = caretOf(client);
			if (!caret) continue;
			let box = caret.getBoundingClientRect();
			let over = pointer !== null
				&& pointer.x >= box.left - REACH && pointer.x <= box.right + REACH
				&& pointer.y >= box.top && pointer.y <= box.bottom;
			if (over) caret.dataset.planHover = "";
			else caret.removeAttribute("data-plan-hover");
		}
	};

	let sync = () => {
		let now = performance.now();
		for (let [client, cursor] of binding.cursors) {
			let selection = cursor.selection;
			if (!selection) {
				forget(client);
				continue;
			}

			let caret = selection.caret;
			let at =
				`${selection.focus.key}|${selection.focus.offset}|${caret.style.left}|${caret.style.top}|${caret.style.height}`;
			let block = binding.editor.getEditorState().read(() => {
				let node = $getNodeByKey(selection.focus.key);
				while (node && (!$isElementNode(node) || node.isInline())) node = node.getParent();
				return node?.getKey();
			});
			let previous = seen.get(client);
			let moved = !previous || previous.at !== at || previous.block !== block;
			if (moved) seen.set(client, { at, block, active: now });
			// Track every movement, but only renew a person's name for a new
			// activity burst or block. Wrapping and inline formatting stay quiet.
			if (
				moved && (!previous || agent(client) || previous.block !== block
					|| now - previous.active >= linger)
			) {
				stop(client);
				timers.set(
					client,
					setTimeout(() => {
						timers.delete(client);
						caretOf(client)?.removeAttribute("data-plan-active");
					}, agent(client) ? agentLinger : linger),
				);
			}

			if (timers.has(client)) {
				caret.dataset.planActive = "";
				place(caret);
			} else caret.removeAttribute("data-plan-active");
		}

		for (let client of seen.keys()) {
			if (!binding.cursors.has(client)) forget(client);
		}

		point();
	};

	let frame = binding.cursorsContainer?.parentElement ?? null;
	let observer = new MutationObserver(sync);
	if (binding.cursorsContainer) {
		observer.observe(binding.cursorsContainer, {
			attributeFilter: ["style"],
			attributes: true,
			childList: true,
			subtree: true,
		});
	}

	let move = (event: PointerEvent) => {
		pointer = { x: event.clientX, y: event.clientY };
		point();
	};
	let leave = () => {
		pointer = null;
		point();
	};
	let selection = () => {
		for (let client of timers.keys()) {
			let caret = caretOf(client);
			if (caret) place(caret);
		}
	};
	frame?.addEventListener("pointermove", move);
	frame?.addEventListener("pointerleave", leave);
	document.addEventListener("selectionchange", selection);

	return {
		sync,

		dispose() {
			observer.disconnect();
			frame?.removeEventListener("pointermove", move);
			frame?.removeEventListener("pointerleave", leave);
			document.removeEventListener("selectionchange", selection);
			for (let timer of timers.values()) clearTimeout(timer);
			timers.clear();
			seen.clear();
		},
	};
}
