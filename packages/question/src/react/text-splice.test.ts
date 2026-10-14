import { expect, test } from "bun:test";
import { crdt, create, normalize, read } from "../index";
import { textSplice } from "./text-splice";

test.each(["", "😀 multilingual 日本語", "line one\nline two", "a😀b", "a😎b"])(
	"text splices preserve Unicode when changing to %s",
	after => {
		let before = "a😀b";
		let edit = textSplice(before, after);
		let result = edit
			? before.slice(0, edit.start) + edit.insert + before.slice(edit.start + edit.remove)
			: before;
		expect(result).toBe(after);
		if (edit) expect(edit.insert).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
	},
);

test("independent written-answer edits merge in either delivery order", () => {
	let definition = normalize({
		questions: [{ header: "Approach", question: "How?", options: [], multiple: false }],
	}, { verbatim: true });
	let original = create(definition);
	original.api.str(["q0", "custom"]).ins(0, "Compare Jev.");
	original.api.flush();
	let change = (model: typeof original, after: string) => {
		let edit = textSplice(read(model, definition).q0!.custom, after)!;
		let value = model.api.str(["q0", "custom"]);
		if (edit.remove) value.del(edit.start, edit.remove);
		if (edit.insert) value.ins(edit.start, edit.insert);
		return model.api.flush();
	};
	let a = change(original.fork(), "Compare self-hosted Jev.");
	let b = change(original.fork(), "Compare Jev alternatives.");
	let first = original.clone();
	first.applyPatch(a);
	first.applyPatch(b);
	let second = original.clone();
	second.applyPatch(b);
	second.applyPatch(a);
	expect(read(first, definition).q0!.custom).toBe("Compare self-hosted Jev alternatives.");
	expect(read(second, definition)).toEqual(read(first, definition));
	first.applyPatch(crdt.Patch.fromBinary(a.toBinary()));
	expect(read(first, definition)).toEqual(read(second, definition));
});
