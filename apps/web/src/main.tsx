import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { adopt } from "./identity";

import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";

import "./theme.css";

// Capture `?as=` and `?key=` before anything renders, so the address bar is
// tidy by the time there is something on screen to screen-share.
adopt();

let root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
