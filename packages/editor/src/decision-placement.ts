/** Browser placement for reader-local decided prose chrome. */

import { useLayoutEffect, useRef, useState } from "react";

import { marginPoint } from "./comment-geometry";
import { blockElement } from "./scroll";

import type { LexicalEditor } from "lexical";
import type { Questionnaire } from "@chopin/dialect";
import type { Question } from "@chopin/protocol";
import type { Point, Rect } from "./comment-geometry";

export type PlacedDecision = {
	id: string;
	key: string;
	block: HTMLElement;
	target: Rect;
	marker: Point;
};
export type DecisionLayout = { host: Rect; placed: PlacedDecision[] };

function rect(value: DOMRect): Rect {
	return {
		top: value.top,
		right: value.right,
		bottom: value.bottom,
		left: value.left,
		width: value.width,
		height: value.height,
	};
}

export function decisionHostVisible(host: HTMLElement): boolean {
	return !host.closest("[hidden], [inert], [aria-hidden='true']")
		&& host.getClientRects().length > 0
		&& host.clientWidth > 0
		&& host.clientHeight > 0;
}

function sameLayout(a: DecisionLayout | undefined, b: DecisionLayout): boolean {
	if (
		!a || a.host.top !== b.host.top || a.host.left !== b.host.left
		|| a.host.width !== b.host.width || a.host.height !== b.host.height
		|| a.placed.length !== b.placed.length
	) return false;
	return a.placed.every((item, index) => {
		let next = b.placed[index];
		return next && item.id === next.id && item.key === next.key
			&& item.block === next.block && item.target.top === next.target.top
			&& item.target.left === next.target.left && item.target.bottom === next.target.bottom
			&& item.target.width === next.target.width;
	});
}

export function useDecisionPlacement(
	{
		editor,
		enter,
		host,
		leave,
		meta,
		onHidden,
		targets,
		values,
	}: {
		editor: LexicalEditor;
		enter: (id: string) => void;
		host: HTMLElement | undefined;
		leave: () => void;
		meta: ReadonlyMap<string, Question.CardMeta>;
		onHidden: () => void;
		targets: Array<{ widget: string; key: string }>;
		values: ReadonlyMap<string, Questionnaire>;
	},
): DecisionLayout | undefined {
	let [layout, setLayout] = useState<DecisionLayout>();
	let layoutRef = useRef(layout);
	let wasVisible = useRef(false);
	layoutRef.current = layout;

	useLayoutEffect(() => {
		if (!host) {
			if (wasVisible.current) onHidden();
			wasVisible.current = false;
			setLayout(undefined);
			return;
		}
		let root = editor.getRootElement();
		let refresh = () => {
			if (!decisionHostVisible(host)) {
				if (wasVisible.current) onHidden();
				wasVisible.current = false;
				setLayout(undefined);
				return;
			}
			wasVisible.current = true;
			let page = rect(host.getBoundingClientRect());
			let placed: PlacedDecision[] = [];
			for (let target of targets) {
				let card = meta.get(target.widget);
				if (card?.status !== "decided" || !card.hasProse || !values.has(target.widget)) continue;
				let block = blockElement(editor, target.key);
				if (!block || !block.isConnected) continue;
				let box = rect(block.getBoundingClientRect());
				if (box.bottom < page.top || box.top > page.bottom) continue;
				placed.push({
					id: target.widget,
					key: target.key,
					block,
					target: box,
					marker: marginPoint(box, page),
				});
			}
			setLayout(current =>
				sameLayout(current, { host: page, placed })
					? current
					: { host: page, placed }
			);
		};
		let moved = (event: PointerEvent) => {
			let target = event.target;
			let id = target instanceof Node
				? layoutRef.current?.placed.find(item => item.block.contains(target))?.id
				: undefined;
			if (id) enter(id);
			else leave();
		};
		let resize = new ResizeObserver(refresh);
		resize.observe(host);
		for (let target of targets) {
			let block = blockElement(editor, target.key);
			if (block) resize.observe(block);
		}
		let attributes = new MutationObserver(refresh);
		for (let node: HTMLElement | null = host; node; node = node.parentElement) {
			attributes.observe(node, {
				attributes: true,
				attributeFilter: ["hidden", "inert", "aria-hidden", "style", "class"],
			});
		}
		refresh();
		root?.addEventListener("pointermove", moved);
		root?.addEventListener("pointerleave", leave);
		window.addEventListener("resize", refresh);
		window.addEventListener("scroll", refresh, true);
		host.addEventListener("transitionend", refresh, true);
		let stopUpdate = editor.registerUpdateListener(refresh);
		return () => {
			stopUpdate();
			resize.disconnect();
			attributes.disconnect();
			root?.removeEventListener("pointermove", moved);
			root?.removeEventListener("pointerleave", leave);
			window.removeEventListener("resize", refresh);
			window.removeEventListener("scroll", refresh, true);
			host.removeEventListener("transitionend", refresh, true);
		};
	}, [editor, enter, host, leave, meta, onHidden, targets, values]);

	return layout;
}
