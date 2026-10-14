import { SQL } from "bun";
import { chatInput } from "./chat-input";
import { seedChildChannel, seedCompletedResearchWorkspace } from "./database";
import { deckSeed } from "./decision-deck-fixtures";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";
import {
	BUILD_ADVICE,
	CHANGED_DIRECTION,
	PAUSE_REQUEST,
	REVISED_ADVICE,
	VAGUE_ADVICE,
} from "./harness/fake-recommendation";

import type { Page } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";
import type { RecommendationSnapshot } from "../packages/protocol/recommendation";
import type { ImplementationSnapshot } from "../packages/protocol/implementation";
import type { Record as Decision } from "../apps/server/src/questions/record-types";

test.setTimeout(90_000);

const SOURCE =
	"# Decision clarity\n\nPeople confuse open decisions with settled ones and cannot find the creation action.\n";
const FEEDBACK =
	"I'm not sure I understand the decision primitive. Are there open decisions, and can I create one manually?";
const SCOPE = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const BROADER_QUESTION = "Should broader onboarding cover every decision type?";
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function supportedFixture(blocked = false) {
	let record: Decision = {
		id: SCOPE,
		origin: "planner",
		status: "answered",
		owner: "ana",
		resolver: "ana",
		decidedAt: 100,
		definition: {
			questions: [{
				id: QUESTION,
				header: "First step",
				question: "What belongs in the first change?",
				multiple: false,
				options: [{
					id: OPTION,
					label: "Status and help copy",
					description: "Keep the existing creation action.",
				}],
			}],
		},
		answers: { [QUESTION]: "Status and help copy" },
		choices: [OPTION],
		history: [],
		optionOrigins: {},
		editors: [],
	};
	let card = `<Questionnaire id="${SCOPE}" by="ana" status="decided">
<Question id="${QUESTION}" header="First step" prompt="What belongs in the first change?" multiple="false">
<Option id="${OPTION}" label="Status and help copy" />
<Answer value="Status and help copy" choices="${OPTION}" />
</Question>
</Questionnaire>`;
	let broader = blocked ? deckSeed({}, 1) : undefined;
	if (broader) {
		let open = broader.state.questions![0] as Decision;
		open.definition.questions[0]!.header = "Onboarding";
		open.definition.questions[0]!.question = BROADER_QUESTION;
		broader.source = broader.source.replace("Storage", "Onboarding")
			.replace("Where should room state live?", BROADER_QUESTION);
	}
	let observed: Chat.Entry = {
		id: "repository-observation",
		author: { kind: "agent" },
		text: "I inspected the current decision entry point.",
		ts: 101,
		tools: [{
			id: "decision-action",
			name: "read_repository_file",
			status: "done",
			args: JSON.stringify({ path: "apps/web/src/decision-view-control.tsx" }),
			result:
				"Observed code: the editor toolbar exposes the existing creation action; a decision can have open or decided status.",
		}],
	};
	return {
		source: `${SOURCE}\n${card}\n${broader?.source ?? ""}`,
		state: {
			revision: 1,
			questions: [record, ...(broader?.state.questions ?? [])],
			openQuestions: broader?.state.openQuestions ?? [],
			transcript: [{
				id: "coworker",
				author: { kind: "member", handle: "bo" },
				text: FEEDBACK,
				ts: 100,
			}, observed],
		},
	};
}

function advice(page: Page, title = BUILD_ADVICE) {
	return page.getByRole("region", { name: title, exact: true });
}

async function send(page: Page, text: string) {
	let chat = page.getByRole("complementary", { name: "Chat", includeHidden: true });
	if (!await chat.isVisible()) {
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat(?:,|$)/ }).click();
	}
	await chatInput(chat).fill(text);
	await chat.getByRole("button", { name: "Send message", exact: true }).click();
}

async function showDocument(page: Page) {
	let phoneNav = page.getByRole("navigation", { name: "Workspace view" });
	if (await phoneNav.isVisible()) {
		await phoneNav.getByRole("button", { name: "Document", exact: true }).click();
	} else {await page.getByRole("group", { name: "Document view" }).getByRole("button", {
			name: "Document",
			exact: true,
		}).click();}
}

async function claimOwner(page: Page) {
	await send(page, "@chopin review the decision clarity document and latest pull request.");
	await expect(page.getByRole("complementary", { name: "Chat", includeHidden: true }))
		.toContainText("Restring the harp section", { timeout: 20_000 });
	await showDocument(page);
}

async function readAdvice(page: Page, room: string): Promise<RecommendationSnapshot> {
	let response = await page.request.get(`/api/channels/${room}/recommendation`);
	expect(response.ok()).toBe(true);
	return response.json();
}

function sentFrames(page: Page) {
	let sends: Chat.Send[] = [];
	let builds: unknown[] = [];
	page.on("websocket", socket =>
		socket.on("framesent", ({ payload }) => {
			if (typeof payload !== "string") return;
			let frame = JSON.parse(payload) as Chat.Send;
			if (frame.kind === "chat:send") sends.push(frame);
			if (frame.kind.startsWith("implementation:")) builds.push(frame);
		}));
	return { sends, builds };
}

test("vague coworker feedback proposes a concrete investigation without changing Build eligibility", async ({ join, page, room, seed }) => {
	await seed(SOURCE, {
		transcript: [{
			id: "coworker",
			author: { kind: "member", handle: "bo" },
			text: FEEDBACK,
			ts: 100,
		}],
	});
	let frames = sentFrames(page);
	await join("ana");
	await claimOwner(page);
	let panel = advice(page, VAGUE_ADVICE);
	await expect(panel).toBeVisible({ timeout: 40_000 });
	await panel.getByRole("button", { name: "Why this step", exact: true }).click();
	await panel.getByRole("button", { name: "Needed for this step", exact: true }).click();
	await expect(panel).toContainText("Observe how open decisions are created");
	let snapshot = await readAdvice(page, room);
	expect(snapshot.state).toBe("ready");
	if (snapshot.state !== "ready") throw new Error("Expected current advice");
	expect(snapshot.recommendation.kind).toBe("investigate");
	expect(snapshot.recommendation.dependencies).not.toHaveLength(0);
	await expect(page.getByRole("button", { name: "Build plan", exact: true })).toBeEnabled();
	expect(frames.builds).toHaveLength(0);
});

test(
	"a supported small build keeps broader work optional and authoritative decisions blocking",
	async ({ join, page, room, seed }, info) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		let fixture = supportedFixture(true);
		await seed(fixture.source, fixture.state);
		let frames = sentFrames(page);
		await join("ana");
		await claimOwner(page);
		let panel = advice(page);
		await expect(panel).toBeVisible({ timeout: 40_000 });
		await panel.getByRole("button", { name: "Why this step", exact: true }).click();
		await panel.getByRole("button", { name: "Can stay open", exact: true }).click();
		await expect(panel.getByText("Repository evidence identifies the existing creation action.", {
			exact: true,
		})).toBeVisible();
		await expect(panel.getByText("Broader onboarding can stay open.", { exact: true }))
			.toBeVisible();
		let blocker = page.getByRole("button", { name: "1 decision left. Show blockers", exact: true });
		await expect(blocker).toBeVisible();
		await expect(page.getByRole("button", { name: "Build plan", exact: true })).toHaveCount(0);
		let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`))
			.json() as ImplementationSnapshot;
		expect(snapshot.buildReady).toBe(false);
		expect(snapshot.blockers).toContain("unanswered questionnaires");
		let screenshot = info.outputPath("next-useful-build-desktop.png");
		await page.screenshot({ path: screenshot, animations: "disabled" });
		await info.attach("Advisory next step with unchanged Build blocker", {
			path: screenshot,
			contentType: "image/png",
		});
		let previousSends = frames.sends.length;
		let current = await readAdvice(page, room);
		if (current.state !== "ready") throw new Error("Expected current advice");
		await panel.getByRole("button", { name: "Discuss with Chopin", exact: true }).click();
		await expect.poll(() => frames.sends.length).toBe(previousSends + 1);
		expect(frames.sends.at(-1)).toMatchObject({
			to: "planner",
			text: `@chopin ${current.recommendation.nextAction}`,
		});
		expect(frames.builds).toHaveLength(0);
		await expect(blocker).toBeVisible();
	},
);

test("dismissal is local, changed human direction hides stale advice and reload keeps the fresh key", async ({ join, page, room, seed }) => {
	let fixture = supportedFixture();
	await seed(fixture.source, fixture.state);
	await join("ana");
	await claimOwner(page);
	let panel = advice(page);
	await expect(panel).toBeVisible({ timeout: 40_000 });
	let original = await panel.getAttribute("data-recommendation-key");
	await panel.getByRole("button", { name: "Keep exploring", exact: true }).click();
	let restore = page.getByRole("button", { name: "Show suggested next step", exact: true });
	await expect(restore).toBeFocused();
	await expect(panel).toHaveCount(0);
	await expect.poll(async () => (await readAdvice(page, room)).state).toBe("ready");
	await expect(restore).toBeVisible();
	await restore.press("Enter");
	await expect(panel.getByRole("button", { name: "Keep exploring", exact: true })).toBeFocused();
	await send(page, CHANGED_DIRECTION);
	await expect(panel).toHaveCount(0, { timeout: 2_000 });
	let revised = advice(page, REVISED_ADVICE);
	await expect(revised).toBeVisible({ timeout: 40_000 });
	let key = await revised.getAttribute("data-recommendation-key");
	expect(key).not.toBe(original);
	await page.reload();
	await ready(page);
	await expect(revised).toBeVisible();
	await expect(revised).toHaveAttribute("data-recommendation-key", key!);
	await send(page, PAUSE_REQUEST);
	await expect(revised).toHaveCount(0, { timeout: 2_000 });
	await expect.poll(async () => (await readAdvice(page, room)).state, { timeout: 40_000 }).toBe(
		"quiet",
	);
	let quiet = await readAdvice(page, room);
	if (quiet.state !== "quiet") throw new Error("Expected current quiet advice");
	expect(quiet.key).not.toBe(key);
	await page.reload();
	await ready(page);
	expect(await readAdvice(page, room)).toEqual(quiet);
	await expect(revised).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Show suggested next step", exact: true }))
		.toHaveCount(0);
});

test("read-only visitors see advice but cannot discuss it with the Planner", async ({ baseURL, browser, join, page, room, seed }) => {
	let fixture = supportedFixture();
	await seed(fixture.source, fixture.state);
	await join("ana");
	await claimOwner(page);
	await expect(advice(page)).toBeVisible({ timeout: 40_000 });
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, `score-reader-advice-${room.slice(0, 8)}`, baseURL!);
		await reader.goto(roomPath(room));
		await expect(reader.locator("[data-plan-synced]")).toBeAttached();
		await expect(advice(reader)).toBeVisible();
		await expect(advice(reader).getByRole("button", { name: "Discuss with Chopin", exact: true }))
			.toBeDisabled();
		await advice(reader).getByRole("button", { name: "Keep exploring", exact: true }).click();
		await expect(reader.getByRole("button", { name: "Show suggested next step", exact: true }))
			.toBeVisible();
	} finally {
		await context.close();
	}
});

test(
	"phone advice wraps, keeps touch targets usable and supports keyboard disclosure",
	async ({ join, room, seed }, info) => {
		let fixture = supportedFixture();
		await seed(fixture.source, fixture.state);
		let phone = await join("ana", PHONE);
		await claimOwner(phone);
		let panel = advice(phone);
		await expect(panel).toBeVisible({ timeout: 40_000 });
		await phone.emulateMedia({ reducedMotion: "reduce" });
		let why = panel.getByRole("button", { name: "Why this step", exact: true });
		await why.focus();
		await phone.keyboard.press("Enter");
		await expect(why).toHaveAttribute("aria-expanded", "true");
		let optional = panel.getByRole("button", { name: "Can stay open", exact: true });
		await optional.focus();
		await phone.keyboard.press("Space");
		await expect(optional).toHaveAttribute("aria-expanded", "true");
		await expect(panel.getByText("Broader onboarding can stay open.", { exact: true }))
			.toBeVisible();
		await expectNoHorizontalOverflow(phone);
		let discussion = panel.getByRole("button", { name: "Discuss with Chopin", exact: true });
		expect((await discussion.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		let key = (await readAdvice(phone, room)).state;
		expect(key).toBe("ready");
		let screenshot = info.outputPath("next-useful-build-phone.png");
		await phone.screenshot({ path: screenshot, animations: "disabled" });
		await info.attach("Phone next-step advice", { path: screenshot, contentType: "image/png" });
	},
);

test("archiving published research without opening the child invalidates parent advice", async ({ baseURL, join, page, room, seed }) => {
	let fixture = supportedFixture();
	await seed(fixture.source, fixture.state);
	let port = Number(new URL(baseURL!).port);
	let child = await seedChildChannel(
		port,
		room,
		crypto.randomUUID(),
		"Decision research",
		"# Decision research\n\nPeople understand open status after a brief explanation.\n",
	);
	let research = await seedCompletedResearchWorkspace(port, room, {
		question: "How do people interpret open decision status?",
		report: {
			title: "Decision research",
			summary: "A short explanation helps.",
			finding: "Open status becomes clear with help copy.",
			caveat: "A small qualitative study.",
			source: { title: "Observed session", url: "https://example.com/decision-session" },
		},
	});
	let database = new SQL(
		process.env.E2E_DATABASE_URL_2
			?? "postgresql://chopin:chopin@127.0.0.1:5435/chopin?sslmode=disable",
	);
	try {
		await database`UPDATE research_workspaces SET published_channel_id = ${child.id} WHERE id = ${research.workspaceId}`;
	} finally {
		await database.close();
	}
	await join("ana");
	await claimOwner(page);
	let panel = advice(page);
	await expect(panel).toBeVisible({ timeout: 40_000 });
	let before = await readAdvice(page, room);
	if (before.state !== "ready") throw new Error("Expected current advice");
	expect(before.evidence.some(item => item.kind === "research")).toBe(true);
	let archived = await page.request.post(`/api/channels/${child.id}/archive`, {
		headers: { origin: baseURL! },
	});
	expect(archived.ok()).toBe(true);
	await expect(panel).toHaveCount(0, { timeout: 2_000 });
	await expect(panel).toBeVisible({ timeout: 40_000 });
	await expect(panel).not.toHaveAttribute("data-recommendation-key", before.key);
	let after = await readAdvice(page, room);
	if (after.state !== "ready") throw new Error("Expected refreshed advice");
	expect(after.evidence.some(item => item.kind === "research")).toBe(false);
});
