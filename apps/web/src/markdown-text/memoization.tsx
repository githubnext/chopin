/**
 * Memoized Markdown components.
 *
 * Adapted from assistant-ui (MIT), packages/react-markdown/src/memoization.tsx, blob
 * 84b15e0198015197c8f18265334b3a0c0a037f0d of assistant-ui/assistant-ui at f92028b4. See
 * THIRD_PARTY_NOTICES.md. Changed from upstream: the hast `Element` type comes from react-markdown's
 * `ExtraProps`, since this workspace does not depend on `@types/hast`.
 */

import { memo } from "react";

import type { ComponentProps, ComponentType, ElementType } from "react";
import type { ExtraProps } from "react-markdown";
import type { CodeHeaderProps, SyntaxHighlighterProps } from "./code-blocks";

/** The hast element react-markdown hands each component as `node`. */
export type HastElement = NonNullable<ExtraProps["node"]>;

type Components =
	& {
		[Key in Extract<ElementType, string>]?: ComponentType<ComponentProps<Key>>;
	}
	& {
		SyntaxHighlighter?: ComponentType<Omit<SyntaxHighlighterProps, "node">> | undefined;
		CodeHeader?: ComponentType<Omit<CodeHeaderProps, "node">> | undefined;
	};

let areValuesEqual = (prev: unknown, next: unknown, depth = 0, skipMetadata = false): boolean => {
	if (Object.is(prev, next)) return true;
	if (depth >= 100) return false;
	if (typeof prev !== "object" || prev === null) return false;
	if (typeof next !== "object" || next === null) return false;

	if (Array.isArray(prev)) {
		if (!Array.isArray(next) || prev.length !== next.length) return false;
		for (let i = 0; i < prev.length; i++) {
			if (!areValuesEqual(prev[i], next[i], depth + 1)) return false;
		}
		return true;
	}
	if (Array.isArray(next)) return false;

	let prevPrototype = Object.getPrototypeOf(prev);
	let nextPrototype = Object.getPrototypeOf(next);
	if (prevPrototype !== Object.prototype && prevPrototype !== null) return false;
	if (nextPrototype !== Object.prototype && nextPrototype !== null) return false;

	let prevRecord = prev as Record<string, unknown>;
	let nextRecord = next as Record<string, unknown>;
	let prevKeys = 0;
	for (let key in prevRecord) {
		if (!Object.hasOwn(prevRecord, key)) continue;
		if (skipMetadata && (key === "position" || key === "data")) continue;
		if (
			!Object.prototype.propertyIsEnumerable.call(nextRecord, key)
			|| !areValuesEqual(prevRecord[key], nextRecord[key], depth + 1)
		) return false;
		prevKeys++;
	}
	let nextKeys = 0;
	for (let key in nextRecord) {
		if (!Object.hasOwn(nextRecord, key)) continue;
		if (skipMetadata && (key === "position" || key === "data")) continue;
		nextKeys++;
	}
	return prevKeys === nextKeys;
};

export let areNodesEqual = (prev: HastElement | undefined, next: HastElement | undefined) => {
	if (!prev || !next) return false;
	if (prev === next) return true;
	return areValuesEqual(prev.properties, next.properties, 0, true)
		&& areValuesEqual(prev.children, next.children);
};

export let memoCompareNodes = (
	prev: { node?: HastElement | undefined },
	next: { node?: HastElement | undefined },
) => {
	return areNodesEqual(prev.node, next.node);
};

let withoutNode = (Component: ComponentType) =>
	memo(
		({ node: _node, ...props }: { node?: HastElement }) => <Component {...props} />,
		memoCompareNodes,
	);

/**
 * Wraps each component so it draws again only when its hast node's content changes. While a
 * message streams, the blocks that are already complete keep their output, and the component
 * never receives `node`.
 */
export let memoizeMarkdownComponents = (components: Components = {}) => {
	return Object.fromEntries(
		Object.entries(components ?? {}).map(([key, value]) => [
			key,
			value ? withoutNode(value as ComponentType) : value,
		]),
	);
};
