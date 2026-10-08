import { createContext, useContext, useState } from "react";

import "./openui-options.css";

import type { ReactNode } from "react";

export type Option = {
	id: "a" | "b" | "c";
	title: string;
	strength: string;
	tradeoff: string;
	detail: string;
	specimen: "current" | "plain" | "styled";
};

type Filter = "all" | Option["specimen"];
type View = "gallery" | "comparison" | "details";

let FilterContext = createContext<Filter>("all");
let ViewContext = createContext<View>("gallery");

export function OptionsSection(
	{ title, introduction, children }: { title: string; introduction: string; children: ReactNode },
) {
	let [filter, setFilter] = useState<Filter>("all");
	return (
		<FilterContext.Provider value={filter}>
			<section className="openui-options" aria-label={title}>
				<header className="openui-options-header">
					<div>
						<h3>{title}</h3>
						<p>{introduction}</p>
					</div>
					<label>
						<span>Show options</span>
						<select
							value={filter}
							onChange={event => setFilter(event.currentTarget.value as Filter)}
						>
							<option value="all">All</option>
							<option value="current">Current default</option>
							<option value="plain">Plain default</option>
							<option value="styled">Styler path</option>
						</select>
					</label>
				</header>
				{children}
			</section>
		</FilterContext.Provider>
	);
}

export function OptionGallery(
	{ title, layout, children }: { title: string; layout: "grid" | "rail"; children: ReactNode },
) {
	return (
		<ViewContext.Provider value="gallery">
			<section className="openui-options-part" aria-label={title}>
				<h4>{title}</h4>
				<div
					className="openui-options-gallery"
					data-layout={layout}
					tabIndex={layout === "rail" ? 0 : undefined}
				>
					{children}
				</div>
			</section>
		</ViewContext.Provider>
	);
}

export function OptionComparison({ title, children }: { title: string; children: ReactNode }) {
	return (
		<ViewContext.Provider value="comparison">
			<section className="openui-options-part" aria-label={title}>
				<h4>{title}</h4>
				<div
					className="openui-options-table-scroll"
					tabIndex={0}
					role="region"
					aria-label="Comparison table"
				>
					<table>
						<thead>
							<tr>
								<th scope="col">Option</th>
								<th scope="col">Strength</th>
								<th scope="col">Tradeoff</th>
							</tr>
						</thead>
						<tbody>{children}</tbody>
					</table>
				</div>
			</section>
		</ViewContext.Provider>
	);
}

export function OptionDetails({ title, children }: { title: string; children: ReactNode }) {
	return (
		<ViewContext.Provider value="details">
			<section className="openui-options-part" aria-label={title}>
				<h4>{title}</h4>
				<div className="openui-options-details">{children}</div>
			</section>
		</ViewContext.Provider>
	);
}

function Specimen({ kind, title }: { kind: Option["specimen"]; title: string }) {
	return (
		<div
			className="openui-options-specimen"
			data-specimen={kind}
			role="img"
			aria-label={`Illustrative spreadsheet for ${title}`}
		>
			<table aria-hidden="true">
				<tbody>
					<tr>
						<th />
						<th>A</th>
						<th>B</th>
					</tr>
					<tr>
						<th>one</th>
						<td>1</td>
						<td>2</td>
					</tr>
					<tr>
						<th>two</th>
						<td>3</td>
						<td>4</td>
					</tr>
				</tbody>
			</table>
		</div>
	);
}

export function DesignOption({ option }: { option: Option }) {
	let filter = useContext(FilterContext);
	let view = useContext(ViewContext);
	if (filter !== "all" && filter !== option.specimen) return null;
	if (view === "comparison") {
		return (
			<tr>
				<th scope="row">{option.title}</th>
				<td>{option.strength}</td>
				<td>{option.tradeoff}</td>
			</tr>
		);
	}
	if (view === "details") {
		return (
			<details>
				<summary>{option.title}</summary>
				<p>{option.detail}</p>
			</details>
		);
	}
	return (
		<article className="openui-options-card">
			<Specimen kind={option.specimen} title={option.title} />
			<div className="openui-options-card-body">
				<span className="openui-options-caption">Illustrative output</span>
				<h5>{option.title}</h5>
				<p>{option.strength}</p>
			</div>
		</article>
	);
}
