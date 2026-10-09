/**
 * A wireframe drawn as inert, semantic DOM.
 *
 * Everything is React elements built from the parsed tree: no markup strings,
 * and no real controls. A button is a span that looks like one, a field is a
 * box with words in it, and the whole drawing is `inert`, so nothing inside
 * takes focus, a click or a caret. Because inert content is also hidden from
 * assistive technology, the region carries a plain outline of the same tree.
 */

import { Fragment, useMemo } from "react";

import { describeWireframePart, wireframeCallouts, wireframeLabel } from "./outline";

import type { ReactNode } from "react";
import type { Wireframe as WireframeTree, WireframeNode } from "./schema";

type Marks = Map<WireframeNode, number[]>;

export type WireframeProps = {
	wireframe: WireframeTree;
	/** Whether the drawing itself takes focus, for a host that opens its source from it. */
	focusable?: boolean;
};

export function Wireframe({ wireframe, focusable = false }: WireframeProps) {
	let { callouts, marks } = useMemo(() => wireframeCallouts(wireframe), [wireframe]);
	return (
		<div
			role="region"
			aria-label={wireframeLabel(wireframe)}
			className="wf"
			data-wireframe=""
			tabIndex={focusable ? 0 : undefined}
		>
			<div className="wf-stage" inert>
				<div className="wf-canvas">
					{wireframe.nodes.map((node, index) => <Part key={index} node={node} marks={marks} />)}
				</div>
				{callouts.length > 0 && (
					<ol className="wf-notes">
						{callouts.map(callout => (
							<li key={callout.number}>
								<span className="wf-mark-chip">{callout.number}</span>
								<span className="wf-note-text">{callout.text}</span>
							</li>
						))}
					</ol>
				)}
			</div>
			<div className="wf-alt">
				<Outline nodes={wireframe.nodes} />
				{callouts.length > 0 && (
					<ol aria-label="Notes">
						{callouts.map(callout => (
							<li key={callout.number}>
								{callout.text}
								{callout.target && ` (on ${describeWireframePart(callout.target)})`}
							</li>
						))}
					</ol>
				)}
			</div>
		</div>
	);
}

/** The text alternative: the same tree as nested lists, notes left to their own list. */
function Outline({ nodes }: { nodes: WireframeNode[] }) {
	let parts = nodes.filter(node => node.kind !== "note");
	if (!parts.length) return null;
	return (
		<ul>
			{parts.map((node, index) => (
				<li key={index}>
					{describeWireframePart(node)}
					{node.kind !== "tabs" && node.items.length > 0 && (
						<ul>{node.items.map((item, at) => <li key={at}>{item.text}</li>)}</ul>
					)}
					{(node.kind !== "disclosure" || node.flags.includes("open"))
						&& <Outline nodes={node.children} />}
				</li>
			))}
		</ul>
	);
}

function has(node: WireframeNode, flag: string): "" | undefined {
	return node.flags.includes(flag) ? "" : undefined;
}

/** Numbered chips on a part that a note points at. */
function Mark({ numbers }: { numbers: number[] | undefined }) {
	if (!numbers) return null;
	return (
		<span className="wf-mark">
			{numbers.map(number => <span className="wf-mark-chip" key={number}>{number}</span>)}
		</span>
	);
}

/** The status glyph: filled, half, ring, dotted ring or struck ring, so tone survives greyscale. */
function Glyph() {
	return <span className="wf-glyph" />;
}

function Part({ node, marks }: { node: WireframeNode; marks: Marks }): ReactNode {
	if (node.kind === "note") return null;
	let numbers = marks.get(node);
	let common = {
		"data-wf": node.kind,
		"data-marked": numbers ? "" : undefined,
		"data-align": node.props.align,
	};
	let mark = <Mark numbers={numbers} />;
	let children = node.children.map((child, index) => (
		<Part
			key={index}
			node={child}
			marks={marks}
		/>
	));

	switch (node.kind) {
		case "panel":
			return (
				<section {...common}>
					{mark}
					{node.label !== undefined && <div className="wf-panel-title">{node.label}</div>}
					{children}
				</section>
			);
		case "header":
			return (
				<header {...common}>
					{mark}
					{node.label !== undefined && <span className="wf-header-title">{node.label}</span>}
					{children}
				</header>
			);
		case "row": {
			let flow = node.flags.includes("flow");
			return (
				<div {...common} data-flow={has(node, "flow")} data-wrap={has(node, "wrap")}>
					{mark}
					{node.children.map((child, index) => (
						<Fragment key={index}>
							{flow && index > 0 && <span className="wf-arrow" />}
							<Part node={child} marks={marks} />
						</Fragment>
					))}
				</div>
			);
		}
		case "stack":
			return <div {...common}>{mark}{children}</div>;
		case "card":
			return (
				<div {...common} data-selected={has(node, "selected")} data-muted={has(node, "muted")}>
					{mark}
					{node.label !== undefined && <span className="wf-card-label">{node.label}</span>}
					{children}
				</div>
			);
		case "title":
			return <div {...common}>{mark}{node.label}</div>;
		case "text":
			return (
				<div {...common} data-muted={has(node, "muted")} data-strong={has(node, "strong")}>
					{mark}
					{node.label}
				</div>
			);
		case "button":
			return (
				<span
					{...common}
					data-primary={has(node, "primary")}
					data-danger={has(node, "danger")}
					data-disabled={has(node, "disabled")}
				>
					{mark}
					{node.flags.includes("danger") && <Glyph />}
					{node.label}
				</span>
			);
		case "badge":
			return (
				<span {...common} data-tone={node.props.tone ?? "neutral"}>
					{mark}
					<Glyph />
					<span className="wf-badge-text">{node.label}</span>
				</span>
			);
		case "disclosure": {
			let open = node.flags.includes("open");
			return (
				<div {...common} data-open={has(node, "open")}>
					{mark}
					<div className="wf-disclosure-summary">
						<span className="wf-chevron" />
						{node.label}
					</div>
					{open && children.length > 0 && <div className="wf-disclosure-body">{children}</div>}
				</div>
			);
		}
		case "list": {
			let items = node.items.map((item, index) => <li key={index}>{item.text}</li>);
			return (
				<div {...common}>
					{mark}
					{node.label !== undefined && <span className="wf-list-label">{node.label}</span>}
					{node.flags.includes("ordered")
						? <ol className="wf-items">{items}</ol>
						: <ul className="wf-items">{items}</ul>}
				</div>
			);
		}
		case "input": {
			let { value, placeholder } = node.props;
			return (
				<div {...common} data-disabled={has(node, "disabled")}>
					{mark}
					{node.label !== undefined && <span className="wf-input-label">{node.label}</span>}
					<span className="wf-input-field" data-value={value !== undefined ? "" : undefined}>
						{value ?? placeholder}
					</span>
				</div>
			);
		}
		case "tabs":
		case "nav": {
			let active = Number(node.props.active ?? (node.kind === "tabs" ? 1 : 0)) - 1;
			return (
				<div {...common} data-vertical={has(node, "vertical")}>
					{mark}
					{node.items.map((item, index) => (
						<span key={index} data-selected={index === active ? "" : undefined}>{item.text}</span>
					))}
				</div>
			);
		}
		case "image":
			return (
				<div {...common} data-ratio={node.props.ratio ?? "wide"}>
					{mark}
					{node.label !== undefined && <span className="wf-image-label">{node.label}</span>}
				</div>
			);
		case "divider":
			return <div {...common} />;
	}
}
