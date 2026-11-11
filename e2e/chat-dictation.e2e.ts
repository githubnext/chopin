/**
 * Dictating a message, in a real browser with a fake `SpeechRecognition`: it listens to nothing, and
 * the spec says what it heard. The button appears only where the browser says speech is recognized on
 * the device, nothing is asked of the microphone before it is pressed, interim words are shown beside
 * the caret and then written there, the draft stays ordinary editable text, and every way of
 * stopping stops it for good. Server transcription is off on this server, so a browser without
 * recognition has no button and sends no audio.
 */
import AxeBuilder from "@axe-core/playwright";

import { chat, composer } from "./chat-attachments";
import { chatCaret, chatInput, expectChatValue, fillChat } from "./chat-input";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { authenticate, expect, ready, roomPath, test } from "./room";

import type { Browser, Page } from "@playwright/test";

declare global {
	interface Window {
		__speech: {
			started: number;
			stopped: number;
			aborted: number;
			lang: string;
			processLocally: boolean | undefined;
			/** What the recognizer is told it heard: the last result is replaced until it is final. */
			say(transcript: string, final: boolean): void;
			fail(error: string): void;
			failOnStart: string | undefined;
			microphone: number;
		};
	}
}

const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};

/** A recognizer as the Web Speech API reports itself, with `processLocally` on its prototype. */
function installRecognizer() {
	let results: Array<{ isFinal: boolean; 0: { transcript: string } }> = [];
	let made: any[] = [];
	class FakeRecognition {
		lang = "";
		continuous = false;
		interimResults = false;
		onstart: ((event: Event) => void) | null = null;
		onresult: ((event: unknown) => void) | null = null;
		onerror: ((event: { error: string }) => void) | null = null;
		onend: ((event: Event) => void) | null = null;
		#ended = false;
		constructor() {
			made.push(this);
		}
		start() {
			window.__speech.started++;
			window.__speech.lang = this.lang;
			window.__speech.processLocally = (this as any).processLocally;
			if (window.__speech.failOnStart) {
				let error = window.__speech.failOnStart;
				queueMicrotask(() => {
					this.onerror?.({ error });
					this.#end();
				});
				return;
			}
			queueMicrotask(() => this.onstart?.(new Event("start")));
		}
		stop() {
			window.__speech.stopped++;
			this.#end();
		}
		abort() {
			window.__speech.aborted++;
			this.#end();
		}
		#end() {
			if (this.#ended) return;
			this.#ended = true;
			queueMicrotask(() => this.onend?.(new Event("end")));
		}
	}
	Object.defineProperty(FakeRecognition.prototype, "processLocally", {
		value: false,
		writable: true,
	});
	(window as any).SpeechRecognition = FakeRecognition;
	(window as any).webkitSpeechRecognition = FakeRecognition;
	let microphone = 0;
	navigator.mediaDevices.getUserMedia = async () => {
		microphone++;
		window.__speech.microphone = microphone;
		throw new DOMException("no", "NotAllowedError");
	};
	window.__speech = {
		started: 0,
		stopped: 0,
		aborted: 0,
		lang: "",
		processLocally: undefined,
		microphone: 0,
		failOnStart: undefined,
		say(transcript, final) {
			let last = results.at(-1);
			if (last && !last.isFinal) {
				last[0] = { transcript };
				last.isFinal = final;
			} else results.push({ isFinal: final, 0: { transcript } });
			made.at(-1).onresult?.({ resultIndex: results.length - 1, results });
		},
		fail(error) {
			made.at(-1).onerror?.({ error });
			made.at(-1).onend?.(new Event("end"));
		},
	};
}

function removeRecognizer() {
	delete (window as any).SpeechRecognition;
	delete (window as any).webkitSpeechRecognition;
}

async function open(
	browser: Browser,
	baseURL: string,
	room: string,
	setup: () => void = installRecognizer,
	options: object = {},
): Promise<Page> {
	let context = await browser.newContext({ baseURL, ...options });
	await context.addInitScript(setup);
	let page = await context.newPage();
	await authenticate(page, "ana", baseURL);
	await page.goto(roomPath(room));
	await ready(page);
	let tab = page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ });
	if (await tab.isVisible()) await tab.click();
	await expect(chatInput(chat(page))).toBeVisible();
	return page;
}

function dictate(page: Page) {
	return composer(page).getByRole("button", { name: "Dictate", exact: true });
}

/** The element's own voice: its dot, its waveform and its clock, above the text while it listens. */
function voice(page: Page) {
	return composer(page).locator('[data-slot="composer-voice"]');
}

/** Why it stopped: the composer's own strip, an alert until it is dismissed (its usual words are a status). */
function failure(page: Page) {
	return composer(page).getByRole("alert");
}

function announcement(page: Page) {
	return composer(page).locator("[data-chat-dictation-announcement]");
}

function heard(page: Page) {
	return page.evaluate(() => ({ ...window.__speech, say: undefined, fail: undefined }));
}

test("offers no microphone where the browser cannot recognize speech, and sends no audio", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room, removeRecognizer);
	let requests: string[] = [];
	page.on("request", request => {
		if (request.url().includes("/transcriptions")) requests.push(request.url());
	});
	await expect(chatInput(chat(page))).toBeVisible();
	await expect(dictate(page)).toHaveCount(0);
	await fillChat(chatInput(chat(page)), "Typing still works");
	expect(requests).toEqual([]);
	// The server has no transcription set up either: its route is not there.
	let probe = await page.request.post(`${baseURL}/api/channels/${room}/transcriptions`, {
		data: "x",
		headers: { origin: baseURL! },
	});
	expect(probe.status()).toBe(404);
});

test("asks nothing of the microphone until the button is pressed, then listens, on the device, in the person's language", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	let button = dictate(page);
	await expect(button).toHaveAttribute("aria-pressed", "false");
	await expect(button).toHaveAttribute(
		"title",
		/^Dictate \(Alt\+Shift\+M\)\. Speech is turned into words on this device\.$/,
	);
	expect(await heard(page)).toMatchObject({ started: 0, microphone: 0 });

	await button.click();
	await expect(button).toHaveAttribute("aria-pressed", "true");
	await expect(announcement(page)).toHaveText("Dictation started");
	expect(await heard(page)).toMatchObject({
		started: 1,
		processLocally: true,
		lang: await page.evaluate(() => navigator.language),
	});
	await expect(voice(page)).toHaveAttribute("data-recording", "true");
	// The clock counts the seconds of the person who is speaking.
	await expect(voice(page)).toContainText(/0:0\d/);
});

test("an empty draft's hint gives way to the first words being said, which would be drawn over it", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	let input = chatInput(chat(page));
	await expect(input).toHaveAttribute("data-empty", "true");
	await dictate(page).click();
	await page.evaluate(() => window.__speech.say("ship the cap", false));
	await expect(input.locator(".draft-interim")).toHaveAttribute("data-interim", "ship the cap");
	// The draft is still empty, and the hint is not drawn under what is being said.
	await expectChatValue(input, "");
	await expect(input).not.toHaveAttribute("data-empty", "true");
	// What was being said when it stopped stays, as words in the draft, so the hint does not return.
	await dictate(page).click();
	await expectChatValue(input, "ship the cap");
	await expect(input).not.toHaveAttribute("data-empty", "true");
});

test("shows what is being said beside the caret, then writes it there, around the words already typed", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	let input = chatInput(chat(page));
	await fillChat(input, "Plan:  today");
	// Put the caret between the two spaces.
	await input.evaluate(element => {
		let text = element.firstChild as Text;
		window.getSelection()!.setBaseAndExtent(text, 6, text, 6);
	});
	await dictate(page).click();
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "true");

	await page.evaluate(() => window.__speech.say("ship the", false));
	// Interim: drawn beside the caret, and not in the draft.
	await expect(input.locator(".draft-interim")).toHaveAttribute("data-interim", "ship the");
	await expectChatValue(input, "Plan:  today");
	await page.evaluate(() => window.__speech.say("ship the cap", false));
	await expect(input.locator(".draft-interim")).toHaveAttribute("data-interim", "ship the cap");
	await expectChatValue(input, "Plan:  today");

	await page.evaluate(() => window.__speech.say("ship the cap fix", true));
	await expectChatValue(input, "Plan: ship the cap fix today");
	await expect(input.locator(".draft-interim")).toHaveCount(0);
	// The caret is after the words, and the next sentence follows them.
	await expect.poll(() => chatCaret(input)).toBe("Plan: ship the cap fix".length);
	await page.evaluate(() => window.__speech.say("on friday", true));
	await expectChatValue(input, "Plan: ship the cap fix on friday today");
});

test("leaves the draft ordinary text: typing and moving the caret take dictation with the person", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	let input = chatInput(chat(page));
	await fillChat(input, "Hello");
	await dictate(page).click();
	await page.evaluate(() => window.__speech.say("big", false));
	// Spaced as typing would be: a space between "Hello" and what is said.
	await expect(input.locator(".draft-interim")).toHaveAttribute("data-interim", " big");
	// Typing is theirs: what was only shown goes, and the next words are written after what they typed.
	await input.press("End");
	await page.keyboard.type(" there");
	await expect(input.locator(".draft-interim")).toHaveCount(0);
	await page.evaluate(() => window.__speech.say("big world", true));
	await expectChatValue(input, "Hello there big world");
	// Moving the caret to the start moves the place the words go.
	await input.press("Home");
	await page.evaluate(() => window.__speech.say("Oh", true));
	await expectChatValue(input, "Oh Hello there big world");
});

test("stops on a second press, and says so once", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	await dictate(page).click();
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "true");
	await dictate(page).click();
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "false");
	await expect(announcement(page)).toHaveText("Dictation stopped");
	await expect(voice(page)).toHaveCount(0);
	expect(await heard(page)).toMatchObject({ started: 1, stopped: 1 });
	// What it hears after it has stopped is ignored.
	await page.evaluate(() => window.__speech.say("late words", true));
	await expectChatValue(chatInput(chat(page)), "");
});

test("stops on Escape, from the field, and keeps what was said", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	let input = chatInput(chat(page));
	await input.focus();
	await dictate(page).click();
	await page.evaluate(() => window.__speech.say("keep this", true));
	await expectChatValue(input, "keep this");
	await input.focus();
	await input.press("Escape");
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "false");
	expect(await heard(page)).toMatchObject({ stopped: 1 });
	await expectChatValue(input, "keep this");
});

test("starts and stops with its shortcut while the field has the focus", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	let input = chatInput(chat(page));
	await input.focus();
	await input.press("Alt+Shift+KeyM");
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "true");
	await input.press("Alt+Shift+KeyM");
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "false");
	expect(await heard(page)).toMatchObject({ started: 1, stopped: 1 });
});

test("sends a message as it was shown, with what was still being said, and stops listening", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	let input = chatInput(chat(page));
	await fillChat(input, "Remember: ");
	await dictate(page).click();
	await page.evaluate(() => window.__speech.say("the cap is a hundred", false));
	await expect(input.locator(".draft-interim")).toHaveAttribute(
		"data-interim",
		"the cap is a hundred",
	);
	await input.press("Enter");
	let message = chat(page).locator("[data-chat-message-id]").filter({
		hasText: "Remember: the cap is a hundred",
	});
	await expect(message).toHaveCount(1);
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "false");
	await expectChatValue(input, "");
	expect(await heard(page)).toMatchObject({ aborted: 1 });
	// Nothing it says afterwards comes back into the composer.
	await page.evaluate(() => window.__speech.say("ghost", true));
	await expectChatValue(input, "");
});

test("never listens in the background: it stops when the page is hidden and when it is left", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	await dictate(page).click();
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "true");
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "false");
	expect(await heard(page)).toMatchObject({ aborted: 1 });
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "visible",
		});
	});
	await dictate(page).click();
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "true");
	await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "false");
	expect(await heard(page)).toMatchObject({ started: 2, aborted: 2 });
});

for (
	let failed of [
		{
			code: "not-allowed",
			words: "Microphone access is blocked. Allow it in your browser's settings to dictate.",
		},
		{ code: "audio-capture", words: "No microphone was found." },
		{
			code: "language-not-supported",
			words: "Dictation isn't available in your language on this device.",
		},
		{ code: "network", words: "Dictation lost its connection. Try again." },
	]
) {
	test(`says ${failed.code} in plain words, stops, and can be tried again`, async ({ browser, baseURL, room }) => {
		let page = await open(browser, baseURL!, room);
		await page.evaluate(code => {
			window.__speech.failOnStart = code;
		}, failed.code);
		await dictate(page).click();
		let alert = failure(page);
		await expect(alert).toContainText(failed.words);
		await expect(alert).toHaveAttribute("role", "alert");
		await expect(dictate(page)).toHaveAttribute("aria-pressed", "false");
		await expect(voice(page)).toHaveCount(0);
		// Told once: the live region says nothing of it, since the alert does.
		await expect(announcement(page)).toHaveText("");
		// Typing is untouched, and a second press tries again and clears the message.
		await fillChat(chatInput(chat(page)), "Still typing");
		await page.evaluate(() => {
			window.__speech.failOnStart = undefined;
		});
		await dictate(page).click();
		await expect(alert).toHaveCount(0);
		await expect(dictate(page)).toHaveAttribute("aria-pressed", "true");
	});
}

test("lets the person dismiss why it stopped", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	await page.evaluate(() => {
		window.__speech.failOnStart = "audio-capture";
	});
	await dictate(page).click();
	let alert = failure(page);
	await expect(alert).toBeVisible();
	await alert.getByRole("button", { name: "Dismiss" }).click();
	await expect(alert).toHaveCount(0);
});

test("holds the pulse still where the person prefers reduced motion", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room, installRecognizer, { reducedMotion: "reduce" });
	await dictate(page).click();
	let dot = voice(page).locator(".animate-pulse");
	await expect(dot).toBeVisible();
	expect(await dot.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
	let moving = await open(browser, baseURL!, room, installRecognizer, {
		reducedMotion: "no-preference",
	});
	await dictate(moving).click();
	let breathing = voice(moving).locator(".animate-pulse");
	await expect(breathing).toBeVisible();
	expect(await breathing.evaluate(element => getComputedStyle(element).animationName)).not.toBe(
		"none",
	);
});

test("is accessible while listening, and while it says why it stopped", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room);
	await dictate(page).click();
	await expect(dictate(page)).toHaveAttribute("aria-pressed", "true");
	let check = async () => {
		let result = await new AxeBuilder({ page }).include(".composer-row").include(
			"[data-chat-dictation], .composer-notice",
		)
			.analyze();
		expect(
			result.violations.map(violation =>
				`${violation.id}: ${violation.help} ${violation.nodes.map(node => node.html).join(" ")}`
			),
		).toEqual([]);
	};
	await check();
	await page.evaluate(() => window.__speech.fail("audio-capture"));
	await expect(failure(page)).toBeVisible();
	await check();
});

test("fits a phone's width, listening and failing, with nothing outside the screen", async ({ browser, baseURL, room }) => {
	let page = await open(browser, baseURL!, room, installRecognizer, PHONE);
	// The microphone is in the row at rest, and the box does not move when the field takes the focus.
	let surface = composer(page).locator(".composer-surface");
	await expect(dictate(page)).toBeVisible();
	// Measured once the pane has slid in and come to rest.
	await expect.poll(async () => (await chat(page).boundingBox())?.x).toBe(0);
	let resting = (await surface.boundingBox())!;
	await chatInput(chat(page)).tap();
	await expect(dictate(page)).toBeVisible();
	expect(await surface.boundingBox()).toEqual(resting);
	await expect(async () => {
		await expectInsideViewport(dictate(page));
	}).toPass({ timeout: 10_000 });
	await dictate(page).click();
	await expect(voice(page)).toBeVisible();
	await expect(async () => {
		await expectInsideViewport(dictate(page));
		await expectInsideViewport(voice(page));
	}).toPass({ timeout: 10_000 });
	await expectNoHorizontalOverflow(page);
	await page.evaluate(() => window.__speech.fail("not-allowed"));
	let alert = failure(page);
	await expect(alert).toBeVisible();
	await expectInsideViewport(alert);
	await expectNoHorizontalOverflow(page);
	// The field is still at least 16px, so a phone does not zoom when it is focused.
	let size = await chatInput(chat(page)).evaluate(element =>
		parseFloat(getComputedStyle(element).fontSize)
	);
	expect(size).toBeGreaterThanOrEqual(16);
});
