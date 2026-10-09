import { installVisualPreviewBridge } from "../../apps/web/src/visual-preview/bridge";

let card = document.getElementById("billing-card")!;
let price = document.getElementById("billing-price")!;

installVisualPreviewBridge(values => {
	let spacing = values.cardSpacing as number;
	card.dataset.spacing = String(spacing);
	card.style.setProperty("--accent", values.accentColor as string);
	price.textContent = `$${spacing * 3} / month`;
});
