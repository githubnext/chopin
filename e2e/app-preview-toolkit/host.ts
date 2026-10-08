import "./host.css";
import {
	type Snapshot,
	validateSnapshot,
} from "../../skills/building-app-previews/assets/controls";
import { definition } from "./definition";
import { namespace, previewOrigin } from "./transport";

function element<T extends HTMLElement>(id: string) {
	return document.getElementById(id) as T;
}
let frame = document.querySelector("iframe")!;
let chosen: Snapshot = { ...definition.baseline };
let spacing = element<HTMLInputElement>("spacing");
let slider = element<HTMLInputElement>("spacing-slider");
let accent = element<HTMLInputElement>("accent");
let error = element("error");
let retry = element<HTMLButtonElement>("retry");
let status = element("status");
let ready = false;
let loaded = false;
let peeking = false;
let sequence = 0;
let attempt = 0;
let timer: ReturnType<typeof setTimeout>;
function fail(message: string) {
	clearTimeout(timer);
	error.textContent = message;
	error.hidden = false;
	retry.hidden = false;
}
function display() {
	element("values").textContent = JSON.stringify(chosen, null, 2);
}
function send() {
	if (!ready) return;
	let id = ++sequence;
	clearTimeout(timer);
	timer = setTimeout(() => fail("Preview did not respond. Your chosen values are kept."), 4000);
	frame.contentWindow?.postMessage({
		namespace,
		type: "apply",
		id,
		values: peeking ? definition.baseline : chosen,
	}, "*");
}
function load() {
	ready = false;
	loaded = false;
	peeking = false;
	element("peek").setAttribute("aria-pressed", "false");
	attempt = ++sequence;
	error.hidden = true;
	retry.hidden = true;
	clearTimeout(timer);
	frame.src = `${previewOrigin}/preview.html?attempt=${sequence}`;
	timer = setTimeout(() => fail("Preview could not load. Retry to keep working."), 4000);
}
frame.addEventListener("load", () => {
	if (!loaded) {
		loaded = true;
		return;
	}
	ready = false;
	++sequence;
	endPeek();
	fail("Preview navigated away. Retry to restore your chosen values.");
});
window.addEventListener("message", (event) => {
	if (
		event.source !== frame.contentWindow || event.origin !== "null"
		|| event.data?.namespace !== namespace
	) return;
	if (event.data.type === "ready" && event.data.attempt === attempt && !ready) {
		clearTimeout(timer);
		ready = true;
		send();
	}
	if (event.data.type === "result" && event.data.id === sequence) {
		clearTimeout(timer);
		if (event.data.ok === true) {
			error.hidden = true;
			retry.hidden = true;
		} else fail(typeof event.data.error === "string" ? event.data.error : "Preview render failed.");
	}
});
for (let input of [spacing, slider, accent]) {
	input.addEventListener("input", () => {
		if (input === slider) spacing.value = slider.value;
		let result = validateSnapshot(definition, {
			spacing: spacing.valueAsNumber,
			accent: accent.value,
		});
		if (!result.ok) {
			fail(result.error.message);
			return;
		}
		chosen = result.value;
		slider.value = String(chosen.spacing);
		display();
		send();
	});
}
element("reset").addEventListener("click", () => {
	chosen = { ...definition.baseline };
	spacing.value = String(chosen.spacing);
	slider.value = String(chosen.spacing);
	accent.value = String(chosen.accent);
	display();
	send();
});
let peek = element<HTMLButtonElement>("peek");
function endPeek() {
	if (peeking) {
		peeking = false;
		peek.setAttribute("aria-pressed", "false");
		send();
	}
}
peek.addEventListener("pointerdown", (event) => {
	peek.setPointerCapture(event.pointerId);
	peeking = true;
	peek.setAttribute("aria-pressed", "true");
	send();
});
for (let event of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) {
	peek.addEventListener(event, endPeek);
}
peek.addEventListener("keydown", (event) => {
	if ((event.key === " " || event.key === "Enter") && !event.repeat) {
		event.preventDefault();
		peeking = true;
		peek.setAttribute("aria-pressed", "true");
		send();
	}
});
peek.addEventListener("keyup", (event) => {
	if (event.key === " " || event.key === "Enter") endPeek();
});
window.addEventListener("blur", endPeek);
document.addEventListener("visibilitychange", () => {
	if (document.hidden) endPeek();
});
element("layout").addEventListener("click", () => {
	let narrow = frame.classList.toggle("narrow");
	element("layout").setAttribute("aria-pressed", String(narrow));
});
element("copy").addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(JSON.stringify(chosen, null, 2));
		status.textContent = "Values copied locally.";
	} catch {
		fail("Could not copy. Download the values instead.");
	}
});
element("download").addEventListener("click", () => {
	let url = URL.createObjectURL(
		new Blob([JSON.stringify(chosen, null, 2)], { type: "application/json" }),
	);
	let link = document.createElement("a");
	link.href = url;
	link.download = "billing-card-values.json";
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
	status.textContent = "Values downloaded locally.";
});
retry.addEventListener("click", async () => {
	retry.disabled = true;
	try {
		let response = await fetch("/retry-build", { method: "POST" });
		if (!(await response.json()).ok) {
			throw new Error("Local build failed. Retry after fixing the source.");
		}
		load();
	} catch (cause) {
		fail(cause instanceof Error ? cause.message : "Retry failed.");
	} finally {
		retry.disabled = false;
	}
});
display();
load();
