import { useState } from "react";
import { StaticPlanEditor } from "@chopin/editor/static";

import gallery from "../../../../experiments/openui-composition-trial/document-gallery-first.md?raw";
import comparison from "../../../../experiments/openui-composition-trial/document-comparison-first.md?raw";
import ordinary from "../../../../experiments/openui-composition-trial/document-ordinary.md?raw";
import gallerySource from "../../../../experiments/openui-composition-trial/source-gallery-first.openui?raw";
import comparisonSource from "../../../../experiments/openui-composition-trial/source-comparison-first.openui?raw";

import "./styles.css";

let views = [
	{ id: "gallery", label: "Gallery first", document: gallery, source: gallerySource },
	{ id: "comparison", label: "Comparison first", document: comparison, source: comparisonSource },
	{ id: "ordinary", label: "Ordinary document", document: ordinary, source: "" },
] as const;

export function OpenUICompositionTrial() {
	let [selected, setSelected] = useState<(typeof views)[number]["id"]>("gallery");
	let view = views.find(item => item.id === selected)!;
	return (
		<main className="openui-trial-page">
			<header className="openui-trial-header">
				<p className="openui-trial-kicker">Bounded composition trial</p>
				<h1>Design options in a Chopin document</h1>
				<p>
					Two authored OpenUI arrangements use the same five components and three option records.
					The ordinary document carries the same source-grounded choices.
				</p>
				<nav aria-label="Trial versions">
					{views.map(item => (
						<button
							key={item.id}
							type="button"
							aria-current={selected === item.id ? "page" : undefined}
							onClick={() => setSelected(item.id)}
						>
							{item.label}
						</button>
					))}
				</nav>
			</header>
			<div className="openui-trial-document">
				<StaticPlanEditor key={view.id} source={view.document} />
			</div>
			{view.source && (
				<details className="openui-trial-source">
					<summary>Authored composition source</summary>
					<pre>{view.source}</pre>
				</details>
			)}
			<p className="openui-trial-note">
				Source: pandas development discussion at checkpoint c1. The gallery specimens are
				illustrations; the screenshot in the document comes from the proposal.
			</p>
		</main>
	);
}
