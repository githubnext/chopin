import { lazy, StrictMode, Suspense } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { usePointerCapabilities } from "@chopin/editor/pointer";

import { App } from "./app";
import { isDesignAuditRoute } from "./design-audit/route";
import { isDiagramGalleryRoute } from "./diagram-gallery/route";
import { useFocusInput } from "./focus-input";
import { useMotionInput } from "./motion-input";
import { watchScrollbarStyle } from "./scrollbars";
import { useVisualViewport } from "./viewport";

import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource/lora/latin-400.css";

import "./theme.css";
import "@chopin/visuals/styles.css";
import "./navigation.css";
import "./phone-skeleton.css";
import "./icon-tooltip.css";
import "./local-login.css";
import "./chat/run-card.css";

let root = document.getElementById("root");
if (!root) throw new Error("missing #root");
watchScrollbarStyle();

function Root() {
	useFocusInput();
	useMotionInput();
	useVisualViewport();
	return <App />;
}

/** Every route, development pages included, mirrors the phone class into CSS. */
function PointerCapabilities() {
	usePointerCapabilities();
	return null;
}

let mount = (
	value: ReactNode,
	{ IconTooltip }: typeof import("./icon-tooltip"),
	feedback?: ReactNode,
) => {
	createRoot(root).render(
		<StrictMode>
			<PointerCapabilities />
			{value}
			<IconTooltip />
			{feedback}
		</StrictMode>,
	);
};

if (import.meta.env.DEV) {
	let content = isDesignAuditRoute(location.pathname, true)
		? import("./design-audit/page").then(({ DesignAuditPage }) => <DesignAuditPage />)
		: isDiagramGalleryRoute(location.pathname, true)
		? import("./diagram-gallery/page").then(({ DiagramGalleryPage }) => <DiagramGalleryPage />)
		: <Root />;
	let Feedback = lazy(() =>
		import("agentation").then(({ Agentation }) => ({ default: Agentation })).catch(() => ({
			default: () => null,
		}))
	);
	void Promise.all([content, import("./icon-tooltip")]).then(
		([value, tooltips]) => mount(
			value,
			tooltips,
			<Suspense fallback={null}>
				<Feedback appName="Chopin" endpoint="http://127.0.0.1:4747" />
			</Suspense>,
		),
	);
} else {
	void import("./icon-tooltip").then(tooltips => mount(<Root />, tooltips));
}
