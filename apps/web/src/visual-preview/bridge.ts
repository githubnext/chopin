import { messageValid } from "./protocol";

import type { Envelope, ParentMessage, Values } from "./protocol";
import type { VisualDecision } from "@chopin/protocol";

export function installVisualPreviewBridge(render: (values: Values) => void | Promise<void>) {
	let current: Envelope | undefined;
	let applied: Envelope | undefined;
	let controls: VisualDecision.Control[] | undefined;
	let parentOrigin: string | undefined;
	let lastSize = "";
	let pending = Promise.resolve();

	function send(type: "ready" | "ack" | "error", envelope: Envelope) {
		if (!parentOrigin) return;
		window.parent.postMessage({ ...envelope, type }, parentOrigin);
	}

	function size() {
		if (!applied || !parentOrigin) return;
		let height = Math.ceil(document.body.scrollHeight);
		if (height < 1 || height > 4096 || `${applied.revision}:${height}` === lastSize) return;
		lastSize = `${applied.revision}:${height}`;
		window.parent.postMessage({ ...applied, type: "size", height }, parentOrigin);
	}

	function onMessage(event: MessageEvent) {
		if (event.source !== window.parent || !messageValid(event.data, "parent", controls)) return;
		let message = event.data as ParentMessage;
		if (current && event.origin !== parentOrigin) return;
		if (message.type === "init") {
			if (current || event.origin === "null") return;
			parentOrigin = event.origin;
			controls = message.controls;
		} else if (
			!current || message.session !== current.session
			|| message.definitionRevision !== current.definitionRevision
			|| message.revision <= current.revision
		) return;
		let envelope: Envelope = {
			version: 1,
			session: message.session,
			revision: message.revision,
			definitionRevision: message.definitionRevision,
			values: { ...message.values },
		};
		current = envelope;
		pending = pending.then(async () => {
			try {
				await render(envelope.values);
				// An acknowledgement means the renderer ran and the browser had a paint opportunity.
				await new Promise<void>(resolve =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				);
				applied = envelope;
				send(message.type === "init" ? "ready" : "ack", envelope);
				size();
			} catch {
				send("error", envelope);
			}
		});
	}

	window.addEventListener("message", onMessage);
	let observer = new ResizeObserver(size);
	observer.observe(document.body);
	return () => {
		window.removeEventListener("message", onMessage);
		observer.disconnect();
	};
}
