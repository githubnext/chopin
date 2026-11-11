import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { rememberAvatars } from "@chopin/editor/people";
import { markdownClass } from "./assistant-ui/markdown-classes.test-fixtures";
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

const A_CLASS = markdownClass("a");

test("routine presence entries stay out of the conversation", () => {
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
		}),
	);

	expect(markup).not.toContain("Sam joined");
	expect(markup).not.toContain("data-chat-system");
	expect(markup).not.toContain("data-motion-feedback");
});

test("a message keeps its actions behind the copied message-actions overflow button, with nothing to take it back", () => {
	let markup = renderToStaticMarkup(
		createElement(Transcript, {
			active: true,
			entries: [{
				id: "mine",
				author: { kind: "member", handle: "ana" },
				text: "One more thought",
				ts: 1_700_000_000,
			}],
			handle: "ana",
		}),
	);

	expect(markup).toContain('data-slot="message-actions"');
	// Slack's vertical three dots, in place of the copy's horizontal ellipsis, in Chopin's icons.
	expect(markup).toMatch(
		/aria-label="Message actions"[^>]*>\s*<[^>]*data-nucleo-icon[^>]*>\s*<g[^>]*>\s*<circle cx="9" cy="3.75"/s,
	);
	expect(markup).not.toContain(">×</button>");
	expect(markup).not.toContain('aria-label="Withdraw queued message"');
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
	}));

	expect(markup).toContain(`<a class="${A_CLASS}" href="${childPath}"`);
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
	}));

	expect(markup).toContain(`<a class="${A_CLASS}" href="${path}"`);
	expect(markup).toContain('rel="noopener noreferrer" target="_blank"');
	expect(markup).toContain(">Open the research document</a>");
	expect(markup).toContain('class="chat-markdown break-words text-base');
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
	}));

	expect(markup).not.toContain("<a");
	expect(markup).not.toContain("data-chat-markdown");
	expect(markup).toContain(text);
});

test("work announcements promise inspectable details only when the turn has tool calls", () => {
	let span = { turnId: "turn", entryOffset: 0, endOffset: 1, anchorId: "agent" };
	let entry: Chat.Entry = {
		author: { kind: "agent" },
		id: "agent",
		text: "Here is the answer.",
		ts: 1,
	};
	let render = (tools: Chat.Activity[] | undefined, suspended: boolean) =>
		renderToStaticMarkup(createElement(Transcript, {
			active: true,
			entries: [{ ...entry, tools }],
			handle: "ana",
			...(suspended ? { suspendedWork: span } : { completedWork: [span] }),
		}));
	let tool: Chat.Activity = { id: "tool", name: "read_plan", status: "done" };

	expect(render(undefined, false)).toContain("Chopin turn ended.</span>");
	expect(render(undefined, true)).toContain("Chopin connection lost.</span>");
	expect(render([tool], false)).toContain(
		"Chopin turn ended. Work details remain available.</span>",
	);
	expect(render([tool], true)).toContain(
		"Chopin connection lost. Work details remain available.</span>",
	);
});

test("people speak with their own picture and no tag; Chopin, a research child and a tool are tagged", () => {
	rememberAvatars([
		{ login: "mona_speaker", avatarUrl: "https://avatars.example.invalid/mona.png" },
		{ login: "hubot_speaker", avatarUrl: "https://avatars.example.invalid/hubot.png" },
	]);
	let childPath = "/documents/octo-org/score/parent/children/vps-costs";
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		entries: [
			{
				author: { kind: "member", handle: "mona_speaker" },
				id: "m1",
				text: "Morning, both.",
				ts: 1_700_000_000,
			},
			{
				author: { kind: "member", handle: "hubot_speaker" },
				id: "m2",
				text: "Morning, Mona.",
				ts: 1_700_000_005,
			},
			{
				author: { kind: "agent" },
				id: "a1",
				text: "I checked the options.",
				tools: [{
					id: "call-1",
					name: "create_research_workspace",
					status: "done",
					args: JSON.stringify({ question: "Compare VPS pricing" }),
					took: 80,
				}],
				ts: 1_700_000_010,
			},
			{
				author: { kind: "system" },
				id: "r1",
				text: `Research is ready. [Open the research document](${childPath}).`,
				ts: 1_700_000_020,
			},
		],
		handle: "mona_speaker",
	}));

	expect(markup.match(/data-speaker-kind="user"/g)).toHaveLength(2);
	expect(markup.match(/data-speaker-kind="agent"/g)).toHaveLength(1);
	expect(markup.match(/data-speaker-kind="subagent"/g)).toHaveLength(1);
	expect(markup).toContain('data-speaker-name="">Mona_speaker</span>');
	expect(markup).toContain('data-speaker-name="">Hubot_speaker</span>');
	expect(markup).toContain('src="https://avatars.example.invalid/mona.png"');
	expect(markup).toContain('src="https://avatars.example.invalid/hubot.png"');
	expect(markup).toContain(
		'data-speaker-name="">Chopin</span><span class="chat-speaker-tag" data-speaker-tag="agent">Agent</span>',
	);
	expect(markup).toContain(
		'data-speaker-name="">Research</span><span class="chat-speaker-tag" data-speaker-tag="subagent">Subagent</span>',
	);
	expect(markup.match(/data-speaker-tag=/g)).toHaveLength(2);
	expect(markup).toContain('data-slot="agent-handoff"');
	expect(markup).toContain("Compare VPS pricing");
});
