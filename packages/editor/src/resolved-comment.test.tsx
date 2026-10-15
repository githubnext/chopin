import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ResolvedComment } from "./resolved-comment";

import type { Comment } from "@chopin/protocol";

let thread: Comment.Thread = {
	id: "t",
	status: "resolved",
	resolver: "olivia",
	notes: [
		{ author: "member", handle: "ana", id: "n1", text: "First note", ts: 1 },
		{ author: "planner", id: "n2", text: "Second note", ts: 2 },
	],
};

describe("ResolvedComment", () => {
	it("previews only the opening note and who resolved it", () => {
		let markup = renderToStaticMarkup(<ResolvedComment pinned={false} thread={thread} />);
		expect(markup).toContain('<div class="plan-resolved-comment"><ol');
		expect(markup).toContain("First note");
		expect(markup).not.toContain("Second note");
		expect(markup).not.toContain("Reopen");
	});

	it("pins every note with Reopen, close and an error", () => {
		let markup = renderToStaticMarkup(
			<ResolvedComment
				error="Couldn’t reopen the comment"
				onReopen={() => {}}
				pinned
				thread={thread}
			/>,
		);
		expect(markup).toContain('data-pinned=""');
		expect(markup).toContain("Second note");
		expect(markup).toContain(">Reopen</button>");
		expect(markup).toContain('data-plan-decision-close=""');
		expect(markup).toContain('role="alert"');
	});

	it("leaves the close to a sheet and marks a pending reopen", () => {
		let markup = renderToStaticMarkup(
			<ResolvedComment onReopen={() => {}} pending pinned sheet thread={thread} />,
		);
		expect(markup).not.toContain("data-plan-decision-close");
		expect(markup).toContain('aria-disabled="true"');
	});
});
