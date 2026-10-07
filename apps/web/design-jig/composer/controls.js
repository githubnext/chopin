let kit = DialKit.createDialKit("Chopin composer", {
	Layout: { width: [360, 280, 480, 10], inset: [12, 8, 20, 1], minHeight: [64, 56, 120, 4] },
	Glow: { opacity: [0.4, 0, 1, 0.01], spread: [10, 0, 96, 1] },
	Motion: { pressScale: [0.99, 0.96, 1, 0.005] },
	Behaviour: { stayInMode: true },
}, { id: "chopin-composer-jig-v4", persist: true });
DialKit.createDialRoot();
let values;
kit.subscribe(next => {
	values = next;
	let root = document.documentElement;
	root.style.setProperty("--jig-width", `${next.Layout.width}px`);
	root.style.setProperty("--composer-inset", `${next.Layout.inset}px`);
	root.style.setProperty("--composer-min-height", `${next.Layout.minHeight}px`);
	root.style.setProperty("--composer-press-scale", next.Motion.pressScale);
	root.style.setProperty("--composer-glow-opacity", next.Glow.opacity);
	root.style.setProperty("--composer-glow-spread", `${next.Glow.spread}px`);
	window.dispatchEvent(new CustomEvent("composer-controls", { detail: next }));
	let output = document.getElementById("chosen-values");
	if (output) {
		output.textContent =
			`${next.Layout.width}px wide · ${next.Layout.inset}px inset · ${next.Layout.minHeight}px input · glow ${
				Math.round(next.Glow.opacity * 100)
			}% / ${next.Glow.spread}px · press ${next.Motion.pressScale} · 120ms`;
	}
});
document.addEventListener("click", async event => {
	if (!event.target.closest("#copy-values")) return;
	let content = JSON.stringify(values, null, 2);
	let box = document.getElementById("values-output");
	box.value = content;
	box.hidden = false;
	try {
		await navigator.clipboard.writeText(content);
		document.getElementById("copy-status").textContent = "Copied values.";
	} catch {
		box.focus();
		box.select();
		document.getElementById("copy-status").textContent = "Select and copy the values below.";
	}
});
