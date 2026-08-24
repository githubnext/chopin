import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadCard } from "./comments";

import type { Comment } from "@chopin/protocol";
import type { ThreadView } from "./threads";

function view(status: Comment.Status, applied = false): ThreadView {
	return {
		thread: {
			id: "thread-1",
			status,
			notes: [{ id: "note-1", handle: "ana", text: "Keep the rollout reversible.", ts: 1 }],
			...(status === "open" ? {} : { resolver: "bo", at: 2 }),
		},
		places: [{ anchorKey: "block", anchorOffset: 0, focusKey: "block", focusOffset: 1 }],
		orphaned: false,
		drifted: false,
		applied,
		quote: "the rollout",
	};
}

function render(value: ThreadView, canEdit: boolean): string {
	return renderToStaticMarkup(
		<ThreadCard
			applied={value.applied}
			canEdit={canEdit}
			inDocument
			onAccept={() => {}}
			onBlur={() => {}}
			onClose={() => {}}
			onDismiss={() => {}}
			onFocus={() => {}}
			onReply={() => {}}
			onRetry={() => {}}
			onReveal={() => {}}
			onTyping={() => {}}
			quote={value.quote}
			view={value}
			writing={["cy"]}
		/>,
	);
}

describe("ThreadCard read-only controls", () => {
	it("keeps reading and navigation while removing open-thread mutations", () => {
		let editable = render(view("open"), true);
		let readOnly = render(view("open"), false);

		expect(editable).toContain("Reply");
		expect(editable).toContain("Accept");
		expect(editable).toContain("Dismiss");
		expect(readOnly).toContain("Keep the rollout reversible.");
		expect(readOnly).toContain("cy is writing");
		expect(readOnly).toContain("show in plan");
		expect(readOnly).toContain("Close comment");
		expect(readOnly).not.toContain("Reply");
		expect(readOnly).not.toContain("Accept");
		expect(readOnly).not.toContain("Dismiss");
		expect(readOnly).not.toContain("textarea");
	});

	it("keeps unapplied status while removing retry", () => {
		let editable = render(view("accepted"), true);
		let readOnly = render(view("accepted"), false);

		expect(editable).toContain("Ask again");
		expect(readOnly).toContain("Not yet applied");
		expect(readOnly).toContain("Accepted by @bo");
		expect(readOnly).not.toContain("Ask again");
	});
});
