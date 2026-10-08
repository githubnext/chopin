import type { VisualDecision } from "@chopin/protocol";

export type PreviewValues = { optionPadding: 4 | 6 | 8; selectedColor: string };
export type Envelope = {
	version: 1;
	session: string;
	revision: number;
	values: PreviewValues;
};
export type ParentMessage = Envelope & { type: "init" | "set" };
export type FrameMessage =
	& Envelope
	& (
		| { type: "ready" | "ack" }
		| { type: "size"; height: number }
	);

export function valuesValid(value: unknown): value is VisualDecision.Values {
	if (!value || typeof value !== "object") return false;
	let values = value as PreviewValues;
	return Object.keys(values).sort().join(",") === "optionPadding,selectedColor"
		&& [4, 6, 8].includes(values.optionPadding)
		&& typeof values.selectedColor === "string"
		&& /^#[0-9A-Fa-f]{6}$/.test(values.selectedColor);
}

export function messageValid(value: unknown, from: "parent" | "frame") {
	if (!value || typeof value !== "object") return false;
	let message = value as FrameMessage | ParentMessage;
	if (
		message.version !== 1 || typeof message.session !== "string"
		|| !/^[A-Za-z0-9_-]{16,64}$/.test(message.session)
		|| !Number.isSafeInteger(message.revision) || message.revision < 0
		|| !valuesValid(message.values)
	) return false;
	let type = message.type;
	if (
		from === "parent"
			? type !== "init" && type !== "set"
			: !["ready", "ack", "size"].includes(type)
	) {
		return false;
	}
	let keys = type === "size"
		? "height,revision,session,type,values,version"
		: "revision,session,type,values,version";
	return Object.keys(message).sort().join(",") === keys
		&& (type !== "size" || ("height" in message && Number.isInteger(message.height)
			&& message.height >= 1 && message.height <= 4096));
}

export function sameValues(left: PreviewValues, right: PreviewValues) {
	return left.optionPadding === right.optionPadding && left.selectedColor === right.selectedColor;
}

export function acceptFrameMessage(
	event: Pick<MessageEvent, "source" | "origin" | "data">,
	current: Envelope & { source: MessageEventSource | null },
): FrameMessage | undefined {
	if (event.source !== current.source || !current.source || event.origin !== "null") return;
	if (!messageValid(event.data, "frame")) return;
	let message = event.data as FrameMessage;
	if (
		message.session !== current.session || message.revision !== current.revision
		|| !sameValues(message.values, current.values)
	) return;
	return message;
}
