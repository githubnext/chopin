import { messageValid, sameValues } from "./protocol";

import type { Envelope, ParentMessage } from "./protocol";

let current: Envelope | undefined;
let parentOrigin: string | undefined;
let lastSize = "";

function size() {
	if (!current || !parentOrigin) return;
	let height = Math.ceil(document.body.scrollHeight);
	if (height < 1 || height > 4096 || `${current.revision}:${height}` === lastSize) return;
	lastSize = `${current.revision}:${height}`;
	window.parent.postMessage({ ...current, type: "size", height }, parentOrigin);
}

window.addEventListener("message", event => {
	if (event.source !== window.parent || !messageValid(event.data, "parent")) return;
	let message = event.data as ParentMessage;
	if (parentOrigin && event.origin !== parentOrigin) return;
	if (message.type === "init") {
		if (current || message.revision !== 0) return;
		parentOrigin = event.origin;
	} else if (
		!current || message.session !== current.session
		|| message.revision < current.revision
		|| (message.revision === current.revision && !sameValues(message.values, current.values))
	) return;
	current = {
		version: 1,
		session: message.session,
		revision: message.revision,
		values: message.values,
	};
	document.documentElement.style.setProperty(
		"--visual-option-padding",
		`${message.values.optionPadding}px`,
	);
	document.documentElement.style.setProperty(
		"--visual-selected-color",
		message.values.selectedColor,
	);
	window.parent.postMessage(
		{ ...current, type: message.type === "init" ? "ready" : "ack" },
		parentOrigin!,
	);
	requestAnimationFrame(size);
});
new ResizeObserver(size).observe(document.body);
