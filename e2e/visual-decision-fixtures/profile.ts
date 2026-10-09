import { installVisualPreviewBridge } from "../../apps/web/src/visual-preview/bridge";

let banner = document.getElementById("profile-banner")!;
let caption = document.getElementById("profile-caption")!;

installVisualPreviewBridge(values => {
	let radius = values.cornerRadius as number;
	banner.dataset.radius = String(radius);
	banner.style.setProperty("--surface", values.surfaceColor as string);
	caption.textContent = `${radius}px corners`;
});
