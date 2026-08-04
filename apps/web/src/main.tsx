import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { adopt } from "./identity";

// The optical-sizing cut: Inter's `opsz` axis retunes letterforms by rendered
// size, which one static outline scaled up and down cannot. Italic is a
// separate face, not a slant, and plans lean on emphasis.
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
