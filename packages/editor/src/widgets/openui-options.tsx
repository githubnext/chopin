import { Component, useState } from "react";

import { parseOptionsSource } from "./openui-options-schema";

import type { OptionModel, OptionsSectionModel, ViewModel } from "./openui-options-schema";
import type { ReactNode } from "react";

import "./openui-options.css";

function Media({ media }: { media: OptionModel["media"] }) {
	let [failed, setFailed] = useState(false);
	return (
		<figure className="openui-options-media">
			{media.kind === "image" && !failed
				? <img src={media.url} alt={media.alt} loading="lazy" onError={() => setFailed(true)} />
				: (
					<div
						className="openui-options-media-text"
						role={media.kind === "image" ? "img" : undefined}
						aria-label={media.kind === "image" ? `Image unavailable: ${media.alt}` : undefined}
					>
						{media.kind === "image" ? "Image unavailable" : media.text}
					</div>
				)}
			<figcaption>{media.caption}</figcaption>
		</figure>
	);
}

function Gallery({ view, options }: { view: ViewModel; options: OptionModel[] }) {
	return (
		<section className="openui-options-part" aria-label={view.title}>
			<h4>{view.title}</h4>
			<div
				className="openui-options-gallery"
				data-layout={view.layout}
				tabIndex={view.layout === "rail" ? 0 : undefined}
				role={view.layout === "rail" ? "region" : undefined}
				aria-label={view.layout === "rail" ? `${view.title} gallery` : undefined}
			>
				{options.map(option => (
					<article className="openui-options-card" key={option.id}>
						<Media media={option.media} />
						<div className="openui-options-card-body">
							<h5>{option.title}</h5>
							<p>{option.strength}</p>
						</div>
					</article>
				))}
			</div>
		</section>
	);
}

function Comparison({ view, options }: { view: ViewModel; options: OptionModel[] }) {
	return (
		<section className="openui-options-part" aria-label={view.title}>
			<h4>{view.title}</h4>
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
					<tbody>
						{options.map(option => (
							<tr key={option.id}>
								<th scope="row">{option.title}</th>
								<td>{option.strength}</td>
								<td>{option.tradeoff}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function Details({ view, options }: { view: ViewModel; options: OptionModel[] }) {
	return (
		<section className="openui-options-part" aria-label={view.title}>
			<h4>{view.title}</h4>
			<div className="openui-options-details">
				{options.map(option => (
					<details key={option.id}>
						<summary>{option.title}</summary>
						<p>{option.detail}</p>
					</details>
				))}
			</div>
		</section>
	);
}

function Section({ section }: { section: OptionsSectionModel }) {
	let [filter, setFilter] = useState("");
	let categories = [...new Set(section.views[0]?.options.map(option => option.category) ?? [])];
	return (
		<section className="openui-options" aria-label={section.title}>
			<header className="openui-options-header">
				<div>
					<h3>{section.title}</h3>
					<p>{section.introduction}</p>
				</div>
				<label>
					<span>Show options</span>
					<select value={filter} onChange={event => setFilter(event.currentTarget.value)}>
						<option value="">All options</option>
						{categories.map(category => <option value={category} key={category}>{category}
						</option>)}
					</select>
				</label>
			</header>
			{section.views.map(view => {
				let options = view.options.filter(option => !filter || option.category === filter);
				if (view.kind === "gallery") {
					return <Gallery key={view.kind} view={view} options={options} />;
				}
				if (view.kind === "comparison") {
					return <Comparison key={view.kind} view={view} options={options} />;
				}
				return <Details key={view.kind} view={view} options={options} />;
			})}
		</section>
	);
}

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed
			? (
				<div className="openui-options-error" data-plan-error="">
					The options could not be drawn. Source is preserved.
				</div>
			)
			: this.props.children;
	}
}

export function OpenUIOptionsPreview({ source }: { source: string }) {
	let result = parseOptionsSource(source);
	if ("error" in result) {
		return (
			<div className="openui-options-error" data-plan-error="">
				{result.error} Source is preserved.
			</div>
		);
	}
	return (
		<div contentEditable={false} data-openui-options-preview="">
			<RenderBoundary>
				<Section section={result.section} />
			</RenderBoundary>
		</div>
	);
}
