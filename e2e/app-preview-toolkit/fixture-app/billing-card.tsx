import type { CSSProperties } from "react";
import { BillingAction, PriceRow } from "./components";
import mark from "./assets/mark.svg";

export function BillingCard(
	{ spacing = 24, accent = "#476b55" }: { spacing?: number; accent?: string },
) {
	return (
		<article
			className="billing-card"
			style={{ "--card-spacing": `${spacing}px`, "--accent": accent } as CSSProperties}
		>
			<header>
				<img src={mark} alt="" width="30" height="30" />
				<span>Fieldwork</span>
				<span className="plan">Studio</span>
			</header>
			<div>
				<h1>A little room to grow.</h1>
				<p>Your workspace, with everything in reach.</p>
			</div>
			<PriceRow />
			<ul>
				<li>Unlimited projects</li>
				<li>Five collaborators</li>
				<li>Shared asset library</li>
			</ul>
			<BillingAction />
		</article>
	);
}
