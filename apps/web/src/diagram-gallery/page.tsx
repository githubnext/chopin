import { useState } from "react";

import { DIAGRAM_FIXTURES } from "@chopin/diagrams/fixtures";
import { Diagram } from "@chopin/diagrams/react";
import { StaticPlanEditor } from "@chopin/editor/static";

import "@chopin/diagrams/styles.css";
import "@chopin/editor/styles.css";
import "./styles.css";

type Fixture = (typeof DIAGRAM_FIXTURES)[number];

let familyLabels: Record<string, string> = {
	charts: "Charts",
	"data-platform": "Data platform",
	process: "Process",
	structure: "Structure",
	systems: "Systems",
};

let familyOrder = ["process", "systems", "structure", "charts", "data-platform"];

function fixture(type: string): Fixture {
	let match = DIAGRAM_FIXTURES.find(item => item.type === type);
	if (match) return match;
	let first = DIAGRAM_FIXTURES[0];
	if (!first) throw new Error("Diagram gallery requires catalogue fixtures.");
	return first;
}

function label(type: string): string {
	let acronym: Record<string, string> = { db: "DB", dp: "DP", er: "ER", it: "IT", uml: "UML" };
	return type.split("-").map((word, index) =>
		acronym[word] ?? (index === 0 ? word.replace(/^./, first => first.toUpperCase()) : word)
	).join(" ");
}

function FeaturedDiagram({ type }: { type: string }) {
	let item = fixture(type);
	return (
		<article className="diagram-gallery-feature" data-featured-type={type}>
			<div className="diagram-gallery-feature-heading">
				<h3>{label(item.type)}</h3>
				<code>{item.type}</code>
			</div>
			<Diagram spec={item.spec} />
		</article>
	);
}

function DocumentSpecimen() {
	let [alternate, setAlternate] = useState(false);
	let [secondMounted, setSecondMounted] = useState(true);
	let first = fixture(alternate ? "state" : "flowchart");
	let second = fixture("sequence");
	return (
		<section
			aria-labelledby="diagram-document-heading"
			className="diagram-gallery-section"
			id="document"
		>
			<div className="diagram-gallery-section-heading">
				<div>
					<p className="diagram-gallery-kicker">Document specimen</p>
					<h2 id="diagram-document-heading">In the reading flow</h2>
				</div>
				<p>
					Development specimen using the document surface. Diagrams are not persisted MDX nodes.
				</p>
			</div>
			<div className="diagram-gallery-specimen-controls">
				<button
					className="btn btn-md btn-secondary"
					onClick={() => setAlternate(value => !value)}
					type="button"
				>
					{alternate ? "Restore first source" : "Replace first source"}
				</button>
				<button
					className="btn btn-md btn-secondary"
					onClick={() => setSecondMounted(value => !value)}
					type="button"
				>
					{secondMounted ? "Unmount second diagram" : "Mount second diagram"}
				</button>
			</div>
			<div className="diagram-gallery-document plan" data-document-specimen="">
				<StaticPlanEditor
					source={"# A shared rendering language\n\nA diagram can sit alongside prose while the document keeps its familiar reading width. The two views below have independent controls, focus, and SVG resources."}
				>
					<div className="plan-content diagram-gallery-document-diagrams">
						<figure data-specimen-diagram="first">
							<Diagram spec={first.spec} />
							<figcaption>{label(first.type)} · first instance</figcaption>
						</figure>
						{secondMounted
							? (
								<figure data-specimen-diagram="second">
									<Diagram spec={second.spec} />
									<figcaption>{label(second.type)} · second instance</figcaption>
								</figure>
							)
							: (
								<p className="diagram-gallery-unmounted" role="status">
									Second diagram unmounted.
								</p>
							)}
					</div>
				</StaticPlanEditor>
			</div>
		</section>
	);
}

export function DiagramGalleryPage() {
	let [selectedType, setSelectedType] = useState("flowchart");
	let selected = fixture(selectedType);
	let families = familyOrder.filter(family =>
		DIAGRAM_FIXTURES.some(item => item.family === family)
	);
	let unknownFamilies = [...new Set(DIAGRAM_FIXTURES.map(item => item.family))].filter(
		family => !familyOrder.includes(family),
	);
	return (
		<main className="diagram-gallery" data-diagram-gallery="">
			<header className="diagram-gallery-header">
				<div>
					<p className="diagram-gallery-kicker">Development gallery · SeeCode rendering module</p>
					<h1>Diagrams in a document</h1>
					<p>
						Browse the retained catalogue, inspect one example at a time, and try two views in a
						document.
					</p>
				</div>
				<a href="#catalogue">Browse {DIAGRAM_FIXTURES.length} types</a>
			</header>

			<section
				aria-labelledby="diagram-featured-heading"
				className="diagram-gallery-section"
				id="featured"
			>
				<div className="diagram-gallery-section-heading">
					<div>
						<p className="diagram-gallery-kicker">Normal document width</p>
						<h2 id="diagram-featured-heading">Three families, one measure</h2>
					</div>
					<p>Graph, sequence, and chart examples at the same width as authored prose.</p>
				</div>
				<div className="diagram-gallery-feature-grid">
					<FeaturedDiagram type="flowchart" />
					<FeaturedDiagram type="sequence" />
					<FeaturedDiagram type="bar" />
				</div>
			</section>

			<DocumentSpecimen />

			<section
				aria-labelledby="diagram-catalogue-heading"
				className="diagram-gallery-section"
				id="catalogue"
			>
				<div className="diagram-gallery-section-heading">
					<div>
						<p className="diagram-gallery-kicker">Catalogue</p>
						<h2 id="diagram-catalogue-heading">Every registered type</h2>
					</div>
					<p>Choose a type to view its resolved fixture through the public renderer.</p>
				</div>
				<div className="diagram-gallery-catalogue">
					<nav aria-label="Diagram types" className="diagram-gallery-types">
						{[...families, ...unknownFamilies].map(family => (
							<div className="diagram-gallery-family" key={family}>
								<h3>{familyLabels[family] ?? label(family)}</h3>
								<ul>
									{DIAGRAM_FIXTURES.filter(item =>
										item.family === family
									).map(item => (
										<li key={item.type}>
											<button
												aria-current={selected.type === item.type ? "true" : undefined}
												onClick={() => setSelectedType(item.type)}
												type="button"
											>
												{label(item.type)}
											</button>
										</li>
									))}
								</ul>
							</div>
						))}
					</nav>
					<div
						aria-live="polite"
						className="diagram-gallery-catalogue-preview"
						data-catalogue-preview=""
					>
						<div className="diagram-gallery-feature-heading">
							<h3>{label(selected.type)}</h3>
							<code>{selected.type}</code>
						</div>
						<p className="diagram-gallery-render-state">
							Rendered from a resolved local fixture
						</p>
						<Diagram spec={selected.spec} />
					</div>
				</div>
			</section>
		</main>
	);
}
