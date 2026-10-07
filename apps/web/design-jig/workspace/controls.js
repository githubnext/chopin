let kit = DialKit.createDialKit("Workspace sizing", {
	Layout: { frameWidth: [1200, 500, 1600, 10] },
}, { id: "chopin-workspace-sizing-v1", persist: true });
DialKit.createDialRoot();
let values = { preferredChat: 500, minimumChat: 250, minimumDocument: 450 };
kit.subscribe(next => {
	document.documentElement.style.setProperty(
		"--workspace-preview-width",
		`${next.Layout.frameWidth}px`,
	);
});
window.addEventListener("workspace-sizing", event => {
	values = { ...values, ...event.detail };
});
document.addEventListener("click", async event => {
	if (!event.target.closest("#workspace-copy-values")) return;
	let content = JSON.stringify(values, null, 2);
	let box = document.getElementById("workspace-values-output");
	box.value = content;
	box.hidden = false;
	let status = document.getElementById("workspace-copy-status");
	try {
		await navigator.clipboard.writeText(content);
		status.textContent = "Copied values.";
	} catch {
		box.focus();
		box.select();
		status.textContent = "Select and copy the values below.";
	}
});
