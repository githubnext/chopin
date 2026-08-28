import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftCard, ThreadCard } from "./comments";

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
		expect(editable).toContain("Apply feedback");
		expect(editable).toContain("Dismiss");
		expect(readOnly).toContain("Keep the rollout reversible.");
		expect(readOnly).toContain("cy is writing");
		expect(readOnly).toContain("Close comment");
		expect(readOnly).not.toContain("Reply");
		expect(readOnly).not.toContain("Apply feedback");
		expect(readOnly).not.toContain("Dismiss");
		expect(readOnly).not.toContain("textarea");
	});

	it("keeps unapplied status while removing retry", () => {
		let editable = render(view("accepted"), true);
		let readOnly = render(view("accepted"), false);

		expect(editable).toContain("Ask again");
		expect(readOnly).toContain("Not yet applied");
		expect(readOnly).toContain('Accepted by <span class="text-brand-ink">@bo</span>');
		expect(readOnly).not.toContain("Ask again");
	});
});

describe("Comment card hierarchy", () => {
	it("aligns the desktop close action with the opening author row", () => {
		let markup = render(view("open"), true);

		expect(markup).not.toContain("plan-comment-header");
		expect(markup).toContain('data-plan-comment-opening-note="true"');
		expect(markup).not.toContain("<h3");
		expect(markup).toContain('aria-label="Close comment"');
		expect(markup.indexOf("@ana")).toBeLessThan(markup.indexOf("Close comment"));
		expect(markup).not.toContain("data-plan-comment-context");
		expect(markup).not.toContain('aria-label="the rollout');
		expect(markup).toContain("text-brand-ink");
	});

	it("keeps a draft focused on writing rather than repeated context", () => {
		let markup = renderToStaticMarkup(
			<DraftCard
				onCancel={() => {}}
				onSend={() => {}}
			/>,
		);

		expect(markup).not.toContain("<h3");
		expect(markup).toContain('aria-label="Close comment"');
		expect(markup).toContain('data-plan-comment-draft-header="true"');
		expect(markup).not.toContain("data-plan-comment-context");
		expect(markup).not.toContain("the rollout");
		expect(markup).not.toContain("resize-y");
	});

	it("uses the inset send action instead of duplicate mobile draft controls", () => {
		let markup = renderToStaticMarkup(
			<DraftCard
				onCancel={() => {}}
				onSend={() => {}}
				showClose={false}
			/>,
		);

		expect(markup).toContain('aria-label="Post comment"');
		expect(markup).toContain('data-inset-send="true"');
		expect(markup).not.toContain(">Comment</button>");
		expect(markup).not.toContain(">Cancel</button>");
	});

	it("uses one inset reply action and orders resolution outcomes", () => {
		let markup = render(view("open"), true);

		expect(markup).toContain('aria-label="Send reply"');
		expect(markup).toContain('data-plan-comment-composer-shell="true"');
		expect(markup).toContain("plan-comment-composer-field field");
		expect(markup).not.toContain(">Reply</button>");
		expect(markup).toContain("Apply feedback");
		expect(markup.indexOf("Dismiss")).toBeLessThan(markup.indexOf("Apply feedback"));
	});
});
