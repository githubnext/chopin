import * as crdt from "json-joy/lib/json-crdt";

export const MAX_TEXT = 2048;
export const MAX_PATCH = 64 * 1024;
export const MAX_MODEL = 256 * 1024;
export type Model = ReturnType<typeof create>;

function bytes(value: number[], maximum: number): Uint8Array {
	if (
		!Array.isArray(value) || !value.length || value.length > maximum
		|| value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
	) throw new Error("Invalid draft bytes");
	return new Uint8Array(value);
}
function text(value: string): void {
	if (
		typeof value !== "string" || value.length > MAX_TEXT
		|| [...value].some(character => {
			let code = character.charCodeAt(0);
			return code === 127 || code < 32 && code !== 9 && code !== 10 && code !== 13;
		})
	) throw new Error("Invalid draft text");
}
export function create(value: string) {
	text(value);
	let model = crdt.Model.create(crdt.schema.obj({ text: crdt.schema.str(value) }));
	model.api.flush();
	return model;
}
export function read(model: Model): string {
	let root = model.root.child();
	if (
		!(root instanceof crdt.ObjNode) || root.keys.size !== 1
		|| !(root.get("text") instanceof crdt.StrNode)
	) throw new Error("Invalid draft shape");
	let value = model.view().text;
	text(value);
	if (model.toBinary().length > MAX_MODEL) throw new Error("Draft history is full");
	return value;
}
export function restore(value: number[]): Model {
	let model = crdt.Model.fromBinary(bytes(value, MAX_MODEL)) as Model;
	read(model);
	return model;
}
export function binary(model: Model): number[] {
	read(model);
	return [...model.toBinary()];
}
export function apply(model: Model, value: number[]): Model {
	let next = model.clone();
	next.applyPatch(crdt.Patch.fromBinary(bytes(value, MAX_PATCH)));
	read(next);
	return next;
}

/** Produce a local splice against the model the input actually displayed. */
export function change(model: Model, value: string): number[] | undefined {
	text(value);
	let before = read(model);
	if (before === value) return;
	let start = 0;
	while (start < before.length && start < value.length && before[start] === value[start]) start++;
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(before[start] ?? "")) start--;
	let end = before.length;
	let nextEnd = value.length;
	while (end > start && nextEnd > start && before[end - 1] === value[nextEnd - 1]) {
		end--;
		nextEnd--;
	}
	if (end < before.length && /[\uDC00-\uDFFF]/u.test(before[end] ?? "")) {
		end++;
		nextEnd++;
	}
	let next = model.clone();
	let string = next.api.str(["text"]);
	if (end > start) string.del(start, end - start);
	if (nextEnd > start) string.ins(start, value.slice(start, nextEnd));
	read(next);
	return [...next.api.flush().toBinary()];
}
