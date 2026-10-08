import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createPreview } from "../../skills/building-app-previews/assets/preview";
import { BillingCard } from "./fixture-app/billing-card";
import "./fixture-app/theme.css";
import { definition } from "./definition";
import { hostOrigin, namespace } from "./transport";

let request = 0;
let rendering = false;
let renderError: Error | undefined;
let pending = Promise.resolve();
let root = createRoot(document.getElementById("app")!, {
	onUncaughtError(error) {
		renderError = error instanceof Error ? error : new Error("React rendering failed.");
		// React can report root errors after flushSync instead of throwing through it.
		if (!rendering) reply({ type: "result", id: request, ok: false, error: renderError.message });
	},
});
let controller = createPreview(definition, async (values) => {
	renderError = undefined;
	rendering = true;
	try {
		flushSync(() =>
			root.render(
				<BillingCard spacing={values.spacing as number} accent={values.accent as string} />,
			)
		);
		await Promise.resolve();
		if (renderError) throw renderError;
	} finally {
		rendering = false;
	}
});
function reply(message: object) {
	parent.postMessage({ namespace, ...message }, hostOrigin);
}
window.addEventListener("message", (event) => {
	if (
		event.source !== parent || event.origin !== hostOrigin || event.data?.namespace !== namespace
	) return;
	let { id, type, values } = event.data;
	if (type !== "apply" || !Number.isSafeInteger(id)) return;
	pending = pending.then(async () => {
		request = id;
		let result = controller.ok ? await controller.value.apply(values) : controller;
		reply({
			type: "result",
			id,
			ok: result.ok,
			error: result.ok ? undefined : result.error.message,
		});
	});
});
reply({ type: "ready", attempt: Number(new URL(location.href).searchParams.get("attempt")) });
