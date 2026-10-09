import type { VisualDecision } from "@chopin/protocol";

export type Values = VisualDecision.Values;
export type Envelope = {
	version: 1;
	session: string;
	revision: number;
	definitionRevision: string;
	values: Values;
};
export type ParentMessage =
	| (Envelope & {
		type: "init";
		controls: VisualDecision.Control[];
		baseline: Values;
	})
	| (Envelope & { type: "set" });
export type FrameMessage =
	& Envelope
	& (
		| { type: "ready" | "ack" }
		| { type: "size"; height: number }
		| { type: "error" }
	);

function keys(value: object) {
	return Object.keys(value).sort().join(",");
}

export function controlsValid(value: unknown): value is VisualDecision.Control[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false;
	let ids = new Set<string>();
	for (let control of value) {
		if (!control || typeof control !== "object") return false;
		if (
			typeof control.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(control.id)
			|| Object.hasOwn(Object.prototype, control.id) || control.id === "prototype"
			|| ids.has(control.id) || typeof control.label !== "string"
			|| !control.label.trim()
		) return false;
		ids.add(control.id);
		if (control.type === "color") {
			if (keys(control) !== "id,label,type") return false;
		} else if (control.type === "number") {
			if (
				keys(control) !== "id,label,max,min,step,type,unit"
				|| typeof control.unit !== "string"
				|| ![control.min, control.max, control.step].every(Number.isFinite)
				|| control.min > control.max || control.step <= 0
			) return false;
		} else return false;
	}
	return true;
}

export function valuesValid(
	controls: readonly VisualDecision.Control[],
	value: unknown,
): value is Values {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (Reflect.ownKeys(value).length !== controls.length) return false;
	let values = value as Values;
	for (let control of controls) {
		if (!Object.hasOwn(values, control.id)) return false;
		let item = values[control.id];
		if (control.type === "color") {
			if (typeof item !== "string" || !/^#[0-9a-f]{6}$/i.test(item)) return false;
		} else {
			let steps = (Number(item) - control.min) / control.step;
			let tolerance = Math.min(
				1e-7,
				Number.EPSILON * 8 * Math.max(1, Math.abs(steps)),
			);
			if (
				typeof item !== "number" || !Number.isFinite(item)
				|| item < control.min || item > control.max
				|| Math.abs(steps - Math.round(steps)) > tolerance
			) return false;
		}
	}
	return true;
}

export function sameValues(left: Values, right: Values) {
	let ids = Object.keys(left);
	return ids.length === Object.keys(right).length && ids.every(id => left[id] === right[id]);
}

export function messageValid(
	value: unknown,
	from: "parent" | "frame",
	controls?: readonly VisualDecision.Control[],
): value is ParentMessage | FrameMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	let message = value as ParentMessage | FrameMessage;
	if (
		message.version !== 1 || typeof message.session !== "string"
		|| !/^[A-Za-z0-9_-]{16,64}$/.test(message.session)
		|| !Number.isSafeInteger(message.revision) || message.revision < 0
		|| typeof message.definitionRevision !== "string"
		|| message.definitionRevision.length < 1 || message.definitionRevision.length > 128
	) return false;
	if (from === "parent" && message.type === "init") {
		return message.revision === 0 && keys(message)
				=== "baseline,controls,definitionRevision,revision,session,type,values,version"
			&& controlsValid(message.controls)
			&& valuesValid(message.controls, message.baseline)
			&& valuesValid(message.controls, message.values);
	}
	if (!controls || !controlsValid(controls) || !valuesValid(controls, message.values)) return false;
	if (from === "parent") {
		return message.type === "set"
			&& keys(message) === "definitionRevision,revision,session,type,values,version";
	}
	if (message.type === "size") {
		return keys(message) === "definitionRevision,height,revision,session,type,values,version"
			&& Number.isInteger(message.height) && message.height >= 1 && message.height <= 4096;
	}
	return ["ready", "ack", "error"].includes(message.type)
		&& keys(message) === "definitionRevision,revision,session,type,values,version";
}

export function acceptFrameMessage(
	event: Pick<MessageEvent, "source" | "origin" | "data">,
	current: Envelope & {
		source: MessageEventSource | null;
		controls: readonly VisualDecision.Control[];
	},
): FrameMessage | undefined {
	if (event.source !== current.source || !current.source || event.origin !== "null") return;
	if (!messageValid(event.data, "frame", current.controls)) return;
	let message = event.data as FrameMessage;
	if (
		message.session !== current.session || message.revision !== current.revision
		|| message.definitionRevision !== current.definitionRevision
		|| !sameValues(message.values, current.values)
	) return;
	return message;
}
