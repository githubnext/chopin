import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { INTERNAL } from "@chopin/protocol/plain-words";

import { ChatComposer } from "./composer";
import { composerModelNotice } from "./model-picker-state";

import type { FileView } from "./attachments/files";
import type { ChatComposerProps } from "./composer";

const INPUT: ChatComposerProps["input"] = {
	mentions: [],
	onChange: () => {},
	onSelect: () => {},
	references: [],
	resetKey: 0,
	value: "",
};

/** The markup, with the apostrophe React escapes in text written back, so copy reads as typed. */
function render(props: Partial<ChatComposerProps> = {}): string {
	return renderToStaticMarkup(createElement(ChatComposer, {
		agent: true,
		draftable: true,
		onSubmit: () => {},
		sendDisabled: false,
		sending: false,
		input: INPUT,
		...props,
	})).replaceAll("&#x27;", "'");
}

test("renders the draft as a combobox in the field", () => {
	let markup = render();
	expect(markup).toContain('class="composer-surface"');
	expect(markup).toContain('role="combobox"');
	expect(markup).toContain('aria-label="Message"');
	expect(markup).toContain("Message the team, or @Chopin to ask");
	expect(markup).not.toContain("composer-notice");
	expect(markup).not.toContain('data-planner="off"');
});

const CHOPIN = { chip: false, disabled: false, onAdd: () => {}, onRemove: () => {} };

test("there is no Chat/Chopin switch: Chopin is asked by a button and a chip, never a mode", () => {
	let off = render({ chopin: CHOPIN });
	expect(off).not.toContain("Talk to Chopin");
	expect(off).not.toContain("data-mode");
	expect(off).not.toContain("composer-chopin-row");
	expect(off).toContain('aria-label="Ask Chopin"');
	expect(off).not.toContain('aria-label="Asking Chopin"');
	expect(off).not.toContain('aria-label="Remove Chopin"');
});

test("the chip starts the field, named for a screen reader, with a button that removes it", () => {
	let on = render({ chopin: { ...CHOPIN, chip: true } });
	expect(on).toMatch(/<span aria-label="Asking Chopin" class="composer-chip" role="group">/);
	expect(on).toContain('aria-label="Remove Chopin"');
	// It comes before the draft in the field, which is what lets the first line begin after it.
	expect(on.indexOf("composer-chip")).toBeLessThan(on.indexOf('role="combobox"'));
	// It is assistant-ui's mention chip: its icon, its label and the cross it draws.
	expect(on).toContain('data-slot="directive-text-chip"');
	expect(on).toContain("Ask Chopin…");
	// Chopin is already being asked, so the button that asks is spent.
	expect(on.match(/<button[^>]*aria-label="Ask Chopin"[^>]*>/)![0]).toContain('disabled=""');
});

test("without an agent there is nobody to ask: no button, no chip, and the team's placeholder", () => {
	let markup = render({ agent: false });
	expect(markup).not.toContain('aria-label="Ask Chopin"');
	expect(markup).not.toContain("composer-chip");
	expect(markup).toContain("Message the team");
	expect(markup).not.toContain("@Chopin");
});

test("a failed send alerts above the field and describes the draft", () => {
	let markup = render({
		notice: {
			tone: "error",
			text: "Message not sent.",
			action: { label: "Retry", onClick: () => {} },
		},
	});
	expect(markup).toMatch(
		/<div class="composer-notice motion-feedback"[^>]*role="alert"[^>]*data-error="true"/,
	);
	expect(markup).toContain('class="btn btn-sm btn-outline-danger"');
	expect(markup).toContain('aria-invalid="true"');
	let cue = markup.match(/role="alert" data-error="true" id="([^"]+)"/)![1]!;
	expect(markup).toContain(`aria-describedby="${cue}"`);
});

test("an informational notice is a status with a ghost action", () => {
	let markup = render({
		agent: false,
		notice: { tone: "info", text: "Chopin unavailable" },
	});
	expect(markup).toContain('data-planner="off"');
	expect(markup).toMatch(/<div class="composer-notice" role="status"/);
	expect(markup).not.toContain("btn-outline-danger");
});

test("read-only and archived documents replace the draft and hide notices", () => {
	let readonly = render({ unavailable: "readonly", notice: { tone: "info", text: "Hidden" } });
	expect(readonly).toContain("Read-only access");
	expect(readonly).not.toContain("Hidden");
	expect(readonly).not.toContain('role="combobox"');
	expect(render({ unavailable: "archived" })).toContain("Document archived");
});

test("shows one run control, and no connection state of its own", () => {
	let markup = render({ run: { action: "stop", disabled: false, onClick: () => {} } });
	expect(markup).toContain('aria-label="Stop generating"');
	expect(markup).not.toContain('aria-label="Resume Chopin"');
	// The document says when the connection is lost, once, at the top of its content.
	expect(markup).not.toContain("composer-connection");
	expect(markup).not.toContain("Reconnect");
	expect(markup).not.toContain("Retry");
});

/** The one send control's tag, which is send or stop and the only one in the composer. */
function roundButton(markup: string): string {
	let buttons = markup.match(/<button[^>]*data-send-stop="[^"]*"[^>]*>/g) ?? [];
	expect(buttons).toHaveLength(1);
	return buttons[0]!;
}

/** Whether the tag carries the `disabled` attribute, which its `disabled:` classes do not. */
const disabled = (tag: string) => / disabled=""/.test(tag);

const STOP = { action: "stop", disabled: false, onClick: () => {} } as const;

test("one round button sends while the Planner is idle, and waits for a draft", () => {
	let waiting = roundButton(render({ sendDisabled: true }));
	expect(waiting).toContain('aria-label="Send message"');
	expect(waiting).toContain('title="Send message"');
	expect(disabled(waiting)).toBe(true);
	let ready = roundButton(render({ input: { ...INPUT, value: "Outline the export" } }));
	expect(ready).toContain('aria-label="Send message"');
	expect(disabled(ready)).toBe(false);
});

test("the same button stops a running Planner while nothing is typed", () => {
	let markup = render({ run: STOP, sendDisabled: true });
	let button = roundButton(markup);
	expect(button).toContain('aria-label="Stop generating"');
	expect(button).toContain('title="Stop generating"');
	expect(disabled(button)).toBe(false);
	// One button, not a Stop beside a Send.
	expect(markup).not.toContain('aria-label="Send message"');
});

test("a message typed while the Planner runs is sent as it is, and the button is stop again once it is gone", () => {
	let typing = render({ run: STOP, input: { ...INPUT, value: "And the rollback checks" } });
	expect(roundButton(typing)).toContain('aria-label="Send message"');
	expect(disabled(roundButton(typing))).toBe(false);
	expect(typing).not.toContain('aria-label="Stop generating"');
	expect(roundButton(render({ run: STOP, sendDisabled: true }))).toContain(
		'aria-label="Stop generating"',
	);
});

test("someone who may not stop the Planner is shown a disabled send, never a stop", () => {
	let markup = render({
		run: { action: "stop", disabled: true, onClick: () => {} },
		sendDisabled: true,
	});
	let button = roundButton(markup);
	expect(button).toContain('aria-label="Send message"');
	expect(disabled(button)).toBe(true);
	expect(markup).not.toContain("Stop generating");
});

test("Resume is a button of its own beside the round one", () => {
	let markup = render({
		run: { action: "resume", disabled: false, onClick: () => {} },
		sendDisabled: true,
	});
	expect(markup).toContain('aria-label="Resume Chopin"');
	expect(roundButton(markup)).toContain('aria-label="Send message"');
});

test("a polite live region waits beside the button, empty until it changes", () => {
	let markup = render({ run: STOP, sendDisabled: true });
	expect(markup).toMatch(
		/<span aria-atomic="true" aria-live="polite" class="sr-only" data-send-stop-status="" role="status"><\/span>/,
	);
});

test("puts nothing beneath the composer, whatever the Planner is doing", () => {
	let markup = render({
		notice: {
			tone: "warning",
			text: "Can't connect to Build box.",
			link: { label: "How to fix", href: "https://example.test/fix" },
		},
	});
	expect(markup.endsWith("</div></div></div>")).toBe(true);
	expect(markup.lastIndexOf("composer-notice")).toBeLessThan(markup.indexOf("composer-surface"));
	// The composer has no slot for anything under it.
	expect(render()).not.toContain("composer-planner");
});

test("a warning is an alert on the composer's top edge: the words, its lines, and a link", () => {
	let markup = render({
		notice: {
			tone: "warning",
			text: "Can't connect to Build box.",
			detail: ["The reason", "Tried 3 times, last at 6:29 PM. Still trying."],
			link: { label: "How to fix", href: "https://example.test/fix" },
		},
	});
	expect(markup).toMatch(/<div class="composer-notice" role="alert" data-warning="true"/);
	expect(markup).toContain("composer-notice-icon");
	expect(markup).toContain("Can't connect to Build box.");
	// Each line stays its own, so nothing is joined to the reason or ended for it.
	expect(markup).toContain(
		'<span class="composer-notice-line">The reason</span>'
			+ '<span class="composer-notice-line">Tried 3 times, last at 6:29 PM. Still trying.</span>',
	);
	expect(markup).toContain(
		'<a class="composer-notice-link" href="https://example.test/fix" rel="noreferrer" target="_blank">How to fix</a>',
	);
	// A warning is not a failed send: the field is not invalid and nothing offers Retry.
	expect(markup).not.toContain("aria-invalid");
	expect(markup).not.toContain("btn-outline-danger");
	// It eases open and shut in the shared collapse track, above the field.
	expect(markup).toMatch(
		/<div class="composer-notice-slot motion-collapse is-open"><div class="motion-collapse-content">/,
	);
	expect(markup.indexOf("composer-notice-slot")).toBeLessThan(markup.indexOf("composer-surface"));
});

test("a strip whose lines are shown draws each exactly as supplied, on a line of its own", () => {
	let reason = "  path ends in a slash /  ";
	let markup = render({
		notice: {
			tone: "warning",
			text: "Can't connect to @mona's machine.",
			detail: [reason, "Tried 3 times, last at 6:29 PM. Still trying."],
			link: { label: "How to fix", href: "https://example.test/fix" },
		},
	});
	expect(markup).toContain(`<span class="composer-notice-line">${reason}</span>`);
	expect(markup).toContain(
		'<span class="composer-notice-line">Tried 3 times, last at 6:29 PM. Still trying.</span>',
	);
	// Drawn, so not repeated for a screen reader.
	expect(markup).not.toContain('<span class="sr-only">');
	// The words, the lines, then the link.
	expect(markup.indexOf("Can't connect")).toBeLessThan(markup.indexOf("composer-notice-line"));
	expect(markup.lastIndexOf("composer-notice-line")).toBeLessThan(
		markup.indexOf("composer-notice-link"),
	);
});

test("a strip another live region announces carries no live role of its own", () => {
	for (let tone of ["warning", "info"] as const) {
		let markup = render({ notice: { tone, text: "Connecting to Build box", silent: true } });
		let strip = /<div class="composer-notice"[^>]*>/.exec(markup)![0];
		expect(strip).not.toContain("role=");
		expect(strip).toContain(`id="`);
	}
	// A failed send still alerts, and is never silent.
	expect(render({ notice: { tone: "error", text: "Message not sent." } })).toContain(
		'role="alert"',
	);
});

test("a failed send is shown at once, not in the easing track", () => {
	let markup = render({ notice: { tone: "error", text: "Message not sent." } });
	expect(markup).toContain('class="composer-notice motion-feedback"');
	expect(markup).not.toContain("composer-notice-slot");
});

test("an information strip eases like a warning, and stays a polite status", () => {
	let markup = render({
		notice: { tone: "info", text: "No machine is connected." },
	});
	expect(markup).toMatch(/<div class="composer-notice" role="status"/);
	expect(markup).toContain("composer-notice-slot motion-collapse is-open");
});

test("a read-only document replaces the strip, whatever it was saying", () => {
	let markup = render({
		unavailable: "readonly",
		notice: { tone: "warning", text: "Can't connect to Build box." },
	});
	expect(markup).not.toContain("Can't connect");
	expect(markup).not.toContain("composer-notice");
});

test("a banner and the composer's own notice are both drawn, and both describe the draft", () => {
	let markup = render({
		banner: {
			id: "lead connection",
			node: createElement("div", { id: "lead", "data-banner": "" }, "No machine is connected."),
		},
		notice: { tone: "info", text: "Research isn't available in this document" },
	});
	expect(markup).toContain("No machine is connected.");
	expect(markup).toContain("Research isn't available in this document");
	let cue = markup.match(/role="status" id="([^"]+)"/)![1]!;
	expect(markup).toMatch(new RegExp(`aria-describedby="lead connection ${cue}"`));
});

test("a banner alone describes the draft by its ids, with no notice strip of its own", () => {
	let alone = render({ banner: { id: "a b", node: createElement("div", { id: "a" }) } });
	expect(alone).toContain('aria-describedby="a b"');
	expect(alone).not.toContain("composer-notice");
});

test("a saved model's fallback notice is drawn beneath a banner as a status, and both describe the draft", () => {
	let words = composerModelNotice(undefined, false, { model: "acme/large" })!;
	expect(words.text).toBe("acme/large is no longer available, so Chopin used its default model.");
	let banner = {
		id: "lead",
		node: createElement("div", { id: "lead", "data-banner": "" }, "No machine is connected."),
	};
	let markup = render({ banner, notice: words });
	// The banner is a cause of its own, above the field; the notice is another, beneath it.
	expect(markup.indexOf("No machine is connected.")).toBeLessThan(markup.indexOf(words.text));
	expect(markup.indexOf(words.text)).toBeLessThan(markup.indexOf("composer-surface"));
	expect(markup).toMatch(/<div class="composer-notice" role="status"/);
	let cue = markup.match(/role="status" id="([^"]+)"/)![1]!;
	expect(markup).toContain(`aria-describedby="lead ${cue}"`);
	// A banner that is not a refused send leaves the field valid.
	expect(markup).not.toContain("aria-invalid");
	// One that is makes the field invalid but does not turn the notice into an alert.
	let refused = render({ banner: { ...banner, invalid: true }, notice: words });
	expect(refused).toContain('aria-invalid="true"');
	expect(refused).toMatch(/<div class="composer-notice" role="status"/);
	expect(refused).not.toContain('role="alert"');
});

const FILES = {
	files: [],
	source: () => undefined,
	disabled: false,
	waiting: false,
	onAdd: () => {},
	onRemove: () => {},
	onRetry: () => {},
};

const VIEW: FileView = {
	id: "a",
	name: "notes.md",
	kind: "file",
	size: 100,
	sizeLabel: "100 B",
	state: "done",
	progress: 100,
	retry: false,
};

test("offers a + that attaches only where the server takes files, and names it as it is", () => {
	let without = render();
	expect(without).not.toContain("Add files");
	expect(without).not.toContain('type="file"');
	let markup = render({ files: FILES });
	expect(markup).toMatch(/<button[^>]*aria-label="Add files"[^>]*title="Add files"/);
	// The picker is a hidden input the + opens: it is never a second control to tab to.
	expect(markup).toMatch(/<input[^>]*hidden=""[^>]*multiple=""[^>]*type="file"/);
	expect(markup).not.toContain("aria-describedby");
});

test("says in the + button's own words why images cannot be added, and offers text to pick", () => {
	let reason = "This model can't read images, so only text files can be sent to it.";
	let markup = render({ files: { ...FILES, imagesReason: reason } });
	expect(markup).toContain(`title="Add files. ${reason}"`);
	expect(markup).toContain(`data-tooltip="Add files. ${reason}"`);
	expect(markup).toMatch(/<span class="sr-only" id="([^"]+)">This model can't read images/);
	let id = markup.match(/<span class="sr-only" id="([^"]+)">This model/)![1]!;
	expect(markup).toContain(`aria-describedby="${id}"`);
	expect(markup).toMatch(/<input[^>]*accept="text\/\*,\.md/);
	// Images are not hidden from the picker where they can be read.
	expect(render({ files: FILES })).not.toContain("accept=");
});

test("switches the + off while a message is being sent, and says what a waiting send waits for", () => {
	let sending = render({ files: { ...FILES, disabled: true }, sending: true });
	expect(sending).toMatch(/<button[^>]*aria-label="Add files"[^>]*disabled=""/);
	let waiting = render({ files: { ...FILES, waiting: true }, sending: true });
	expect(waiting).toContain('role="status">Sending once your files have uploaded');
	expect(render({ files: FILES })).not.toContain("Sending once your files");
});

test("an archived or read-only document offers no + that attaches", () => {
	expect(render({ files: FILES, unavailable: "archived" })).not.toContain("Add files");
});

test("none of the words about files uses a term of Chopin's own", () => {
	let markup = render({
		files: {
			...FILES,
			waiting: true,
			imagesReason: "This model can't read images, so only text files can be sent to it.",
		},
	});
	let words = [
		...markup.matchAll(/\b(?:aria-label|data-tooltip|title)="([^"]*)"/g),
		...markup.matchAll(/>([^<>]+)</g),
	].map(match => match[1]!);
	expect(words.some(text => text.includes("Add files"))).toBe(true);
	for (let text of words) expect(INTERNAL.test(text), text).toBe(false);
});

const DICTATION = {
	active: false,
	phase: "idle" as const,
	seconds: 0,
	tooltip: "Dictate (Alt+Shift+M). Speech is turned into words on this device.",
	announcement: "",
	onToggle: () => {},
	disabled: false,
};

test("offers the microphone only where speech can be turned into words, named as it is", () => {
	expect(render()).not.toContain('aria-label="Dictate"');
	expect(render()).not.toContain("data-chat-dictation-announcement");
	let idle = render({ dictation: DICTATION });
	expect(idle).toMatch(/<button[^>]*aria-label="Dictate"[^>]*aria-pressed="false"/);
	expect(idle).toContain('data-slot="composer-voice-button"');
	expect(idle).toContain(
		'title="Dictate (Alt+Shift+M). Speech is turned into words on this device."',
	);
	expect(idle).toMatch(
		/<p[^>]*aria-live="polite"[^>]*data-chat-dictation-announcement=""[^>]*role="status"/,
	);
	expect(idle).not.toContain('data-slot="composer-voice"');
});

test("puts the microphone in the bottom row, with the other controls and before the model pill", () => {
	let markup = render({ dictation: DICTATION });
	let row = markup.slice(markup.indexOf('class="composer-row"'));
	let left = row.slice(0, row.indexOf('class="composer-actions"'));
	expect(left).toContain('aria-label="Dictate"');
	// The staged files and the voice are above the text, never in the row.
	expect(left).not.toContain('data-slot="composer-voice"');
});

test("shows that it is listening with the time so far above the text, and says when it is working on a recording", () => {
	let listening = render({
		dictation: { ...DICTATION, active: true, phase: "listening", seconds: 65 },
	});
	expect(listening).toMatch(/<button[^>]*aria-label="Dictate"[^>]*aria-pressed="true"/);
	let voice = listening.indexOf('data-slot="composer-voice"');
	expect(voice).toBeGreaterThan(-1);
	// Above the field the words go in, as the staged files are.
	expect(voice).toBeLessThan(listening.indexOf('role="combobox"'));
	expect(listening).toMatch(/data-slot="composer-voice"[^>]*data-recording="true"/);
	// A minute is a minute: the element's own clock would say 0:65.
	expect(listening).toContain(">1:05<");
	expect(listening).not.toContain("0:65");
	let transcribing = render({
		dictation: { ...DICTATION, active: true, phase: "transcribing", seconds: 3 },
	});
	expect(transcribing).toContain("Transcribing");
	expect(transcribing).not.toContain("data-recording");
});

test("starting, before the browser has let it listen, draws no voice yet", () => {
	let starting = render({ dictation: { ...DICTATION, active: false, phase: "starting" } });
	expect(starting).not.toContain('data-slot="composer-voice"');
});

test("none of the words about dictation uses a term of Chopin's own", () => {
	let markup = render({
		dictation: {
			...DICTATION,
			active: true,
			phase: "transcribing",
			announcement: "Dictation started",
		},
		notice: {
			tone: "warning",
			text: "Microphone access is blocked. Allow it in your browser's settings to dictate.",
			action: { label: "Dismiss", onClick: () => {} },
		},
	});
	let words = [
		...markup.matchAll(/\b(?:aria-label|data-tooltip|title)="([^"]*)"/g),
		...markup.matchAll(/>([^<>]+)</g),
	].map(match => match[1]!);
	expect(words.some(text => text.includes("Dictation started"))).toBe(true);
	for (let text of words) expect(INTERNAL.test(text), text).toBe(false);
});

test("a message of only files is sent by the round button, which stops Chopin only for an empty one", () => {
	let running: Partial<ChatComposerProps> = {
		run: { action: "stop", disabled: false, onClick: () => {} },
	};
	let staged = { ...FILES, files: [{ ...VIEW, state: "done" as const }] };
	// With nothing to send, the button that sends is the one that stops.
	expect(render({ ...running, files: FILES })).toContain('aria-label="Stop generating"');
	// A file is a message: the same button sends it.
	let withFile = render({ ...running, files: staged });
	expect(withFile).toContain('aria-label="Send message"');
	expect(withFile).not.toContain('aria-label="Stop generating"');
});
