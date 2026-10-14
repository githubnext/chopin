import { lazy, StrictMode, Suspense } from "react";
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

let content = isDesignAuditRoute(location.pathname, import.meta.env.DEV)
	? import("./design-audit/page").then(({ DesignAuditPage }) => <DesignAuditPage />)
	: isDiagramGalleryRoute(location.pathname, import.meta.env.DEV)
	? import("./diagram-gallery/page").then(({ DiagramGalleryPage }) => <DiagramGalleryPage />)
	: Promise.resolve(<Root />);

let Feedback = import.meta.env.DEV
	? lazy(() =>
		import("agentation").then(({ Agentation }) => ({ default: Agentation })).catch(() => ({
			default: () => null,
		}))
	)
	: undefined;

void Promise.all([content, import("./icon-tooltip")]).then(
	([value, { IconTooltip }]) => {
		createRoot(root).render(
			<StrictMode>
				<PointerCapabilities />
				{value}
				<IconTooltip />
				{Feedback && (
					<Suspense fallback={null}>
						<Feedback appName="Chopin" endpoint="http://127.0.0.1:4747" />
					</Suspense>
				)}
			</StrictMode>,
		);
	},
);
