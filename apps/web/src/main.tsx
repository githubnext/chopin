import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { usePointerCapabilities } from "@chopin/editor/pointer";

import { App } from "./app";
import { isDesignAuditRoute } from "./design-audit/route";
import { useFocusInput } from "./focus-input";
import { useMotionInput } from "./motion-input";
import { useVisualViewport } from "./viewport";

import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";

import "./theme.css";
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
	: Promise.resolve(<Root />);

void Promise.all([content, import("./icon-tooltip")]).then(([value, { IconTooltip }]) => {
	createRoot(root).render(
		<StrictMode>
			{value}
			<IconTooltip />
		</StrictMode>,
	);
});
