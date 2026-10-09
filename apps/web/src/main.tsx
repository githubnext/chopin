import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { usePointerCapabilities } from "@chopin/editor/pointer";

import { App } from "./app";
import { isDesignAuditRoute } from "./design-audit/route";
import { isDiagramGalleryRoute } from "./diagram-gallery/route";
import { useFocusInput } from "./focus-input";
import { useMotionInput } from "./motion-input";
import { useVisualViewport } from "./viewport";

import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource/lora/latin-400.css";

import "./theme.css";
import "@chopin/visuals/styles.css";
import "./navigation.css";
import "./icon-tooltip.css";
import "./local-login.css";
import "./chat/run-card.css";

let root = document.getElementById("root");
if (!root) throw new Error("missing #root");

function Root() {
	useFocusInput();
	useMotionInput();
	usePointerCapabilities();
	useVisualViewport();
	return <App />;
}

let content = isDesignAuditRoute(location.pathname, import.meta.env.DEV)
	? import("./design-audit/page").then(({ DesignAuditPage }) => <DesignAuditPage />)
	: isDiagramGalleryRoute(location.pathname, import.meta.env.DEV)
	? import("./diagram-gallery/page").then(({ DiagramGalleryPage }) => <DiagramGalleryPage />)
	: Promise.resolve(<Root />);

let agentation = import.meta.env.DEV
	? import("agentation").then(({ Agentation }) => (
		<Agentation appName="Chopin" endpoint="http://127.0.0.1:4747" />
	))
	: Promise.resolve(null);

void Promise.all([content, import("./icon-tooltip"), agentation]).then(
	([value, { IconTooltip }, feedback]) => {
		createRoot(root).render(
			<StrictMode>
				{value}
				<IconTooltip />
				{feedback}
			</StrictMode>,
		);
	},
);
