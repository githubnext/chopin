import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { usePointerCapabilities } from "@chopin/editor/pointer";

import { App } from "./app";
import { useVisualViewport } from "./viewport";

import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";

import "./theme.css";
import "./navigation.css";

let root = document.getElementById("root");
if (!root) throw new Error("missing #root");

function Root() {
	usePointerCapabilities();
	useVisualViewport();
	return <App />;
}

createRoot(root).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
