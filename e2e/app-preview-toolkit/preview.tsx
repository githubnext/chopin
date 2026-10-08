import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createPreview } from "../../skills/building-app-previews/assets/preview";
import { BillingCard } from "./fixture-app/billing-card";
import "./fixture-app/theme.css";
import { definition } from "./definition";
import { hostOrigin, namespace } from "./transport";

let root = createRoot(document.getElementById("app")!);
let controller = createPreview(definition, (values) => {
	flushSync(() =>
		root.render(<BillingCard spacing={values.spacing as number} accent={values.accent as string} />)
	);
});
function reply(message: object) {
	parent.postMessage({ namespace, ...message }, hostOrigin);
}
window.addEventListener("message", async (event) => {
	if (
		event.source !== parent || event.origin !== hostOrigin || event.data?.namespace !== namespace
	) return;
	let { id, type, values } = event.data;
	if (type !== "apply" || !Number.isSafeInteger(id)) return;
	let result = controller.ok ? await controller.value.apply(values) : controller;
	reply({ type: "result", id, ok: result.ok, error: result.ok ? undefined : result.error.message });
});
reply({ type: "ready", attempt: Number(new URL(location.href).searchParams.get("attempt")) });
