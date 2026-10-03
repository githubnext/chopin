import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Transcript } from "./transcript";
import { childDocumentPath } from "@chopin/protocol/document-url";
import {
	answerArtifact,
	evidenceArtifact,
	settle,
	setup,
} from "../../../server/src/research/test-support";
import { terminalNotices } from "../../../server/src/research/inline.test-fixtures";

import type { Chat } from "@chopin/protocol";

test("system presence entries stay immediate when they arrive", () => {
	let markup = renderToStaticMarkup(
		createElement(Transcript, {
			active: true,
			entries: [{
				author: { kind: "system" },
				id: "joined",
				text: "@sam joined",
				ts: 1_700_000_000,
			}],
			handle: "ana",
			onWithdraw: () => {},
			queued: [],
		}),
	);

	expect(markup).toContain("Sam joined");
	expect(markup).not.toContain("data-motion-feedback");
});

test("queued messages use the standard icon-button glyph", () => {
	let markup = renderToStaticMarkup(
		createElement(Transcript, {
			active: true,
			entries: [],
			handle: "ana",
			onWithdraw: () => {},
			queued: [{ handle: "ana", id: "queued", text: "One more thought" }],
		}),
	);

	expect(markup).toMatch(/aria-label="Withdraw queued message"[^>]*>.*?height="14"/s);
	expect(markup).toMatch(/aria-label="Withdraw queued message"[^>]*>.*?width="14"/s);
	expect(markup).toContain("<title>xmark</title>");
	expect(markup).not.toContain(">×</button>");
});

test("a ready research notice links to its child document while other notices stay plain text", () => {
	let childPath = "/documents/octo-org/score/parent/children/research";
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: [
			{
				author: { kind: "system" },
				id: "ready",
				text: `Research is ready. [Open the research document](${childPath}).`,
				ts: 1_700_000_000,
			},
			{
				author: { kind: "system" },
				id: "failed",
				text: "Research could not be completed. You can retry it from the research card.",
				ts: 1_700_000_001,
			},
		],
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
	}));

	expect(markup).toContain(`<a href="${childPath}"`);
	expect(markup).toContain(">Open the research document</a>");
	expect(markup).toContain(
		"Research could not be completed. You can retry it from the research card.",
	);
	expect(markup.match(/data-chat-markdown/g)).toHaveLength(1);
});

test("system notices with arbitrary Markdown remain text", () => {
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: [{
			author: { kind: "system" },
			id: "other",
			text: "[Outside](https://example.com) <b>unsafe</b>",
			ts: 1_700_000_000,
		}],
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
	}));

	expect(markup).not.toContain("<a");
	expect(markup).not.toContain("<b>");
	expect(markup).toContain("[Outside](https://example.com) &lt;b&gt;unsafe&lt;/b&gt;");
});

test("a ready notice cannot turn an external destination into a system link", () => {
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: [{
			author: { kind: "system" },
			id: "outside",
			text: "Research is ready. [Open the research document](https://example.com).",
			ts: 1_700_000_000,
		}],
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
	}));

	expect(markup).not.toContain("<a");
	expect(markup).toContain("[Open the research document](https://example.com)");
});

test("the published ready notice renders its actual child route in Transcript", async () => {
	let context = await setup();
	let started = await context.service.startPlannerInline({
		channelId: context.channelId,
		question: "Check the release",
		originMessageId: "message-transcript-ready",
		requestedBy: context.userId,
		placeReference: async () => "placed",
	});
	let evidence = await settle(context, "research-evidence", evidenceArtifact);
	await context.service.jobChanged(evidence.job);
	let answer = await settle(context, "research-answer", answerArtifact);
	let { service, notices } = terminalNotices(context);
	await service.jobChanged(answer.job);
	let request = await service.request(context.channelId, started.request.id);
	if (request?.stage !== "ready") throw new Error("published research child is not ready");
	let path = childDocumentPath(
		context.channel.repositoryOwner,
		context.channel.repositoryName,
		context.channel.slug,
		request.child.slug,
	);
	expect(notices).toHaveLength(1);
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: notices.map((notice): Chat.Entry => ({
			...notice,
			author: { kind: "system" },
			ts: 1,
		})),
		handle: "ana",
		onWithdraw() {},
		queued: [],
	}));

	expect(markup).toContain(`<a href="${path}"`);
	expect(markup).toContain('rel="noopener noreferrer" target="_blank"');
	expect(markup).toContain(">Open the research document</a>");
	expect(markup).toContain('class="chat-markdown min-w-0 break-words text-sm');
	expect(markup).not.toContain("[Open the research document]");
});

test.each([
	"/documents/octo-org/score/parent",
	"/documents/octo-org/score/parent/children/",
	"/documents/octo-org/score/parent/children/%ZZ",
	"/documents/octo-org/score/parent/children/research?next=https://example.com",
	"/documents/octo-org/score/parent/children/research#report",
	"/documents/octo-org/score/parent/children/research/extra",
	"//example.com/documents/octo-org/score/parent/children/research",
	"javascript:alert(1)",
])("ready notices with an invalid child route stay text: %s", path => {
	let text = `Research is ready. [Open the research document](${path}).`;
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: [{ author: { kind: "system" }, id: "invalid", text, ts: 1 }],
		handle: "ana",
		onWithdraw() {},
		queued: [],
	}));

	expect(markup).not.toContain("<a");
	expect(markup).not.toContain("data-chat-markdown");
	expect(markup).toContain(text);
});

test("a ready link with extra system prose remains plain text", () => {
	let text = "Research is ready. [Open the research document]"
		+ "(/documents/octo-org/score/parent/children/research). [Extra](https://example.com).";
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: [{ author: { kind: "system" }, id: "extra", text, ts: 1 }],
		handle: "ana",
		onWithdraw() {},
		queued: [],
	}));

	expect(markup).not.toContain("<a");
	expect(markup).not.toContain("data-chat-markdown");
	expect(markup).toContain(text);
});
