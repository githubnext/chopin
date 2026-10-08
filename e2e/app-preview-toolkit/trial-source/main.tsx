import { createRoot } from "react-dom/client";
import { UnitsProvider } from "./providers";
import { UsageCard } from "./usage-card";
import "./theme.css";

let usage = { service: "API requests", used: 640, limit: 1000, period: "October 2026" };

createRoot(document.getElementById("app")!).render(
	<UnitsProvider>
		<main className="relay-page">
			<UsageCard usage={usage} />
		</main>
	</UnitsProvider>,
);
