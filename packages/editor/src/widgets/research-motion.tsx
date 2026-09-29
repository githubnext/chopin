import { useEffect, useRef, useState } from "react";

import type { ReactNode } from "react";

const SWAP_MS = 240;

type Layer = { id: string; key: number; initial: boolean; leaving: boolean; node: ReactNode };

/**
 * Crossfades between keyed content. The outgoing layer stays mounted long
 * enough to leave, stacked in the same grid cell as the one arriving. The first
 * layer appears without a fade.
 */
export function Swap(
	{ children, className, id }: { children: ReactNode; className?: string; id: string },
) {
	let [layers, setLayers] = useState<Layer[]>([
		{ id, initial: true, key: 0, leaving: false, node: children },
	]);
	let keys = useRef(0);
	let latest = useRef(id);
	let timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	// Removal timers outlive re-renders; clearing them on a dependency change
	// would strand a leaving layer in the DOM.
	useEffect(() => () => timers.current.forEach(clearTimeout), []);
	useEffect(() => {
		if (latest.current === id) {
			setLayers(current =>
				current.map(layer =>
					layer.id === id && !layer.leaving ? { ...layer, node: children } : layer
				)
			);
			return;
		}
		latest.current = id;
		let key = ++keys.current;
		setLayers(current => [
			...current.filter(layer => !layer.leaving).map(layer => ({ ...layer, leaving: true })),
			{ id, initial: false, key, leaving: false, node: children },
		]);
		let timer = setTimeout(() => {
			timers.current.delete(timer);
			setLayers(current => current.filter(layer => !layer.leaving || layer.key > key));
		}, SWAP_MS);
		timers.current.add(timer);
	}, [id, children]);
	return (
		<span className={`plan-research-swap${className ? ` ${className}` : ""}`}>
			{layers.map(layer => (
				<span
					aria-hidden={layer.leaving || undefined}
					data-initial={layer.initial ? "" : undefined}
					inert={layer.leaving}
					data-leaving={layer.leaving ? "" : undefined}
					key={layer.key}
				>
					{layer.node}
				</span>
			))}
		</span>
	);
}

/**
 * Opens and closes a block by animating its grid row so height never jumps.
 * A closed fold is inert and hidden from assistive technology.
 */
export function Fold({ children, open }: { children: ReactNode; open: boolean }) {
	return (
		<div
			aria-hidden={open ? undefined : true}
			className="plan-research-fold"
			data-open={open ? "" : undefined}
			inert={!open}
		>
			<div>{children}</div>
		</div>
	);
}

/** The latest defined value, so content can finish leaving after it is gone. */
export function useLast<T>(value: T | undefined): T | undefined {
	let last = useRef(value);
	if (value !== undefined) last.current = value;
	return last.current;
}
