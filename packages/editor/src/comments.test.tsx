import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { composerKey, DraftCard, mention, stamp, ThreadCard } from "./comments";
import { displayName } from "./display-name";

import type { Comment } from "@chopin/protocol";
import type { ThreadView } from "./threads";

function note(id: string, handle: string, text: string): Comment.Note {
	return { id, author: "member", handle, text, ts: 1 };
}

function view(notes = [note("note-1", "ana", "Keep the rollout reversible.")]): ThreadView {
	return {
		thread: { id: "thread-1", status: "open", notes },
		places: [{ anchorKey: "block", anchorOffset: 0, focusKey: "block", focusOffset: 1 }],
		orphaned: false,
		drifted: false,
		applied: false,
		quote: "the rollout",
	};
}

function render(value: ThreadView, canEdit: boolean): string {
	return renderToStaticMarkup(
		<ThreadCard
			canEdit={canEdit}
			link="https://chopin.test/doc#comment-thread-1"
			onBlur={() => {}}
			onFocus={() => {}}
			onReply={() => {}}
			onResolve={() => {}}
			onTyping={() => {}}
			quote={value.quote}
			view={value}
			writing={["cy"]}
		/>,
	);
}

describe("ThreadCard controls", () => {
	it("offers reply and resolve to writers, and only reading and Copy link otherwise", () => {
		let editable = render(view(), true);
		let readOnly = render(view(), false);

		expect(editable).toContain('aria-label="Reply"');
		expect(editable).toContain('aria-label="Resolve"');
		expect(editable).toContain('aria-label="More actions"');
		expect(readOnly).toContain("Keep the rollout reversible.");
		expect(readOnly).toContain("cy is writing");
		expect(readOnly).toContain('aria-label="More actions"');
		expect(readOnly).not.toContain('aria-label="Resolve"');
		expect(readOnly).not.toContain("textarea");
	});

	it("has no apply, dismiss or close controls", () => {
		let markup = render(view(), true);

		expect(markup).not.toContain("Apply feedback");
		expect(markup).not.toContain("Dismiss");
		expect(markup).not.toContain("Close comment");
	});

	it("puts the header actions in the opening note's author row", () => {
		let markup = render(view(), true);
		let head = markup.slice(
			markup.indexOf("plan-comment-note-head"),
			markup.indexOf("plan-comment-note-body"),
		);

		expect(head).toContain(">Ana<");
		expect(head).toContain('aria-label="Resolve"');
		expect(markup).not.toContain("data-plan-comment-context");
	});

	it("shows authors as chat does: a face, a display name and the handle for assistive tech", () => {
		let markup = render(view(), true);

		expect(markup).toContain('<span aria-hidden="true" class="relative grid');
		expect(markup).toContain('alt=""');
		expect(markup).not.toContain('aria-label="ana"');
		expect(markup).toContain(">Ana<");
		expect(markup).toContain("(@ana)");
	});

	it("folds the middle of a long thread behind a count", () => {
		let notes = ["one", "two", "three", "four", "five"].map((text, index) =>
			note(`n${index}`, "ana", text)
		);
		let markup = render(view(notes), true);

		expect(markup).toContain("one");
		expect(markup).toContain("Show 3 replies");
		expect(markup).not.toContain(">two<");
		expect(markup).not.toContain(">four<");
		expect(markup).toContain("five");
	});

	it("shows every note of a short thread", () => {
		let notes = ["one", "two", "three"].map((text, index) => note(`n${index}`, "ana", text));
		let markup = render(view(notes), true);

		expect(markup).not.toContain("Show");
		expect(markup).toContain(">two<");
	});

	it("starts a reply as one quiet line with its footer folded away", () => {
		let markup = render(view(), true);

		expect(markup).toContain('data-mode="reply"');
		expect(markup).not.toContain("data-open");
		expect(markup).toContain('placeholder="Reply"');
		expect(markup).toContain('aria-label="Send reply"');
	});
});

describe("DraftCard", () => {
	it("is only a composer, with its footer open and no header", () => {
		let markup = renderToStaticMarkup(<DraftCard onCancel={() => {}} onSend={() => {}} />);

		expect(markup).not.toContain("<h3");
		expect(markup).not.toContain("Close comment");
		expect(markup).toContain('placeholder="Add a comment"');
		expect(markup).toContain('data-mode="new"');
		expect(markup).toContain('data-open="true"');
		expect(markup).toContain('aria-label="Post comment"');
		expect(markup).toContain("disabled");
		expect(markup).not.toContain("the rollout");
	});
});

describe("stamp", () => {
	let now = new Date(2026, 9, 10, 15, 0);

	it("gives a time for today and a date otherwise", () => {
		let today = new Date(2026, 9, 10, 13, 7).getTime() / 1_000;
		let earlier = new Date(2026, 9, 2, 13, 7).getTime() / 1_000;
		let lastYear = new Date(2025, 9, 2, 13, 7).getTime() / 1_000;

		expect(stamp(today, now)).toMatch(/13|1:07/);
		expect(stamp(earlier, now)).not.toMatch(/:/);
		expect(stamp(lastYear, now)).toContain("2025");
	});
});

describe("Comment composer keys", () => {
	let key = (
		name: string,
		extra: Partial<{ shiftKey: boolean; isComposing: boolean; keyCode: number }> = {},
	) => ({ key: name, shiftKey: false, isComposing: false, ...extra });

	it("sends on Enter and keeps Shift-Enter for a newline", () => {
		expect(composerKey(key("Enter"), false)).toBe("send");
		expect(composerKey(key("Enter", { shiftKey: true }), false)).toBeUndefined();
		expect(composerKey(key("Escape"), false)).toBe("cancel");
	});

	it("never sends while an IME candidate is being confirmed", () => {
		expect(composerKey(key("Enter", { isComposing: true }), false)).toBeUndefined();
		expect(composerKey(key("Enter", { keyCode: 229 }), false)).toBeUndefined();
	});

	it("treats Enter as a newline on a coarse pointer, leaving sending to the button", () => {
		expect(composerKey(key("Enter"), true)).toBeUndefined();
		expect(composerKey(key("Escape"), true)).toBe("cancel");
	});
});

describe("displayName", () => {
	it("names a person as Chat does", () => {
		expect(displayName("ana")).toBe("Ana");
		expect(displayName("")).toBe("");
	});
});

describe("Sending to Chopin", () => {
	it("offers Send to Chopin, unticked, beside the send", () => {
		let markup = renderToStaticMarkup(<DraftCard onCancel={() => {}} onSend={() => {}} />);

		expect(markup).toContain("Send to Chopin");
		expect(markup).toMatch(/<input[^>]*type="checkbox"/);
		expect(markup).not.toMatch(/<input[^>]*checked/);
	});

	it("keeps the reply's Send to Chopin folded away until the field is used", () => {
		let markup = render(view(), true);

		expect(markup).toContain("Send to Chopin");
		expect(markup).toMatch(/plan-comment-composer-footer"[^>]*inert/);
	});

	it("draws the address from the note's destination, not its text", () => {
		let sent = { ...note("note-1", "ana", "Shorter, please."), to: "planner" as const };
		let markup = render(view([sent]), true);

		expect(markup).toContain('class="plan-comment-mention">@Chopin</span>');
		expect(markup).toContain("Shorter, please.");
	});

	it("names Chopin by its mark on its own notes", () => {
		let markup = render(
			view([
				note("note-1", "ana", "Why 60s?"),
				{ id: "note-2", author: "planner", text: "It matches the CDN TTL.", ts: 2 },
			]),
			true,
		);

		expect(markup).toContain('aria-label="Chopin"');
		expect(markup).toContain(">Chopin</span>");
		expect(markup).toContain("It matches the CDN TTL.");
	});

	it("says Chopin is working, and why it stopped when it did", () => {
		let working = render({ ...view(), planner: "working" }, true);
		expect(working).toContain("Chopin is working on it");
		expect(working).toContain('role="status"');
		expect(working).toContain("plan-comment-dots");

		expect(render({ ...view(), planner: "stopped" }, true)).toContain("Chopin stopped");
		expect(render({ ...view(), planner: "failed" }, true)).toContain("Chopin couldn&#x27;t reply");
		expect(render({ ...view(), planner: "off" }, true)).toContain("Chopin isn&#x27;t running");
		expect(render(view(), true)).not.toContain("Chopin is working");
	});
});

describe("mention", () => {
	it("turns @chopin into the address once the word ends, whatever its case", () => {
		expect(mention("@chopin", 7)).toBeUndefined();
		expect(mention("@Chopin ", 8)).toEqual({ text: "", caret: 0 });
		expect(mention("please @CHOPIN fix this", 15)).toEqual({ text: "please fix this", caret: 7 });
		expect(mention("@chopin, why?", 8)).toEqual({ text: ", why?", caret: 1 });
	});

	it("leaves other words alone", () => {
		expect(mention("@chopinesque ", 13)).toBeUndefined();
		expect(mention("mail@chopin ", 12)).toBeUndefined();
	});
});
