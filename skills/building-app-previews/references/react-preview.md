# React preview integration

Trace imports from the real app entry, including required theme/router/query or
domain providers, CSS order, aliases and child components. Match React and UI
dependency versions. Import the same browser view in the source and preview;
when a server component loads data or owns effects, extract its presentational
view and pass deterministic props. Record the extraction and fixture differences.
An absent required provider is a dependency failure, not a reason to redraw UI.

Bundle static styles, local fonts and referenced images using the app's build
pipeline. Portals must mount inside the preview document with their context,
styles and focus behaviour preserved. Runtime CSS injection and large bundles
are compatibility cases: verify emitted/injected styles, load failures and actual
browser behaviour in the intended isolation, then report measured limits.

## Helper adapter

Copy both helper assets next to each other. This illustrates local parameter names,
not production capability identifiers; derive yours from the target app.

```tsx
import { createPreview } from "./helpers/preview";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AppProviders, AppView } from "./app-view";

// AppView/AppProviders stand for exports inspected in your target app.
export async function buildAdapter(
	container: HTMLElement,
	reportFailure: (error: Error) => void,
) {
	let definition = {
		controls: [
			{ type: "number", id: "gap", label: "Gap", unit: "px", min: 4, max: 32, step: 1 },
			{ type: "color", id: "tint", label: "Tint" },
		],
		baseline: { gap: 16, tint: "#3565a8" },
	};
	let applying = false;
	let failure: Error | undefined;
	function failed(error: unknown) {
		let seen = new Set<Error>();
		while (error instanceof Error && error.cause instanceof Error && !seen.has(error)) {
			seen.add(error);
			error = error.cause;
		}
		failure = error instanceof Error ? error : new Error("React rendering failed.");
		if (!applying) reportFailure(failure);
	}
	let root = createRoot(container, {
		onUncaughtError: failed,
		onRecoverableError: failed,
	});
	let preview = createPreview(definition, async (values) => {
		failure = undefined;
		applying = true;
		try {
			flushSync(() =>
				root.render(
					<AppProviders>
						<AppView gap={values.gap as number} tint={values.tint as string} />
					</AppProviders>,
				)
			);
			await Promise.resolve();
			if (failure) throw failure;
		} finally {
			applying = false;
		}
	});
	if (!preview.ok) return preview;
	let baseline = await preview.value.reset();
	if (!baseline.ok) return baseline;
	return preview;
}
```

## React 19 errors

`flushSync` can return after React routes a real render/commit failure through a
root callback. Capture both `createRoot` options `onUncaughtError` and
`onRecoverableError`. A genuine portal failure may produce minified wrapper #520
whose `Error.cause` holds the useful original error. Safely walk cause chains with
cycle protection; preserve that cause in the error shown to the host.

Track the active request and serialize adapter work. During an apply, capture root
errors, call `flushSync(() => root.render(view))`, allow callback processing and
throw a captured error through the helper renderer. Keep the callbacks active
after apply: late root errors must report failure for the active rendered request
through the supplied host contract. A recoverable error merits visible review even
if React repairs the DOM. If your own error boundary catches a failure, forward it
too. Arbitrary event-handler failures need separate reporting; these root callbacks
do not establish complete exception coverage.

A helper success reports callback completion. Confirm paint and fidelity in the
browser with actual component DOM, computed styles and screenshots. For Retry,
wait for a different frame/attempt to navigate and its fresh resources to load,
then assert the real component and retained values. React may have repaired the
old DOM before Retry; matching styles there are a false readiness signal. Use
observable readiness and bounded waits rather than arbitrary sleeps.
