import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";

import "./theme.css";

let root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
