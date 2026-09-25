import { toHex } from "@chopin/color";
import { useId } from "react";

import type { SwatchRef, TokenRow } from "@chopin/color";

export type TokenListProps = {
	rows: readonly TokenRow[];
	swatches: readonly SwatchRef[];
	onRetarget(token: string, ref: SwatchRef | null): void;
	onOpen(ref: SwatchRef, anchor: HTMLElement): void;
};

function TokenItem({ row, swatches, onRetarget, onOpen }: TokenListProps & { row: TokenRow }) {
	let id = useId();
	let selected = `${id}:${JSON.stringify([row.ref.hue, row.ref.step])}`;
	let available = swatches.some(ref => ref.hue === row.ref.hue && ref.step === row.ref.step);
	let options = swatches.map(ref => ({
		ref,
		label: `${ref.hue} ${ref.step}`,
		value: `${id}:${JSON.stringify([ref.hue, ref.step])}`,
	}));
	return (
		<div className="cv-token-row">
			<button
				className="cv-token-name"
				disabled={!row.value}
				onClick={event => onOpen(row.ref, event.currentTarget)}
				type="button"
			>
				{row.name}
			</button>
			<span aria-hidden="true" className="cv-token-leader" />
			<span className="cv-token-ref">
				<select
					aria-label={`${row.name} color`}
					data-tone={row.value ? undefined : "danger"}
					onChange={event => {
						let option = options.find(item => item.value === event.currentTarget.value);
						if (option) onRetarget(row.name, option.ref);
					}}
					value={available ? selected : `${id}:missing`}
				>
					{!available && <option disabled value={`${id}:missing`}>missing</option>}
					{options.map(option => (
						<option key={option.value} value={option.value}>{option.label}</option>
					))}
				</select>
				{row.retargeted && (
					<button
						aria-label={`Reset ${row.name} color`}
						className="cv-token-was"
						onClick={() => onRetarget(row.name, null)}
						type="button"
					>
						was {row.original.hue} {row.original.step}
					</button>
				)}
			</span>
			<button
				aria-label={`Open ${row.ref.hue} ${row.ref.step}`}
				className="cv-token-swatch"
				data-tone={row.value ? undefined : "danger"}
				disabled={!row.value}
				onClick={event => onOpen(row.ref, event.currentTarget)}
				style={row.value ? { background: toHex(row.value) } : undefined}
				type="button"
			>
				{!row.value && <span className="cv-visually-hidden">missing</span>}
			</button>
		</div>
	);
}

export function TokenList(props: TokenListProps) {
	let groups = new Map<string, TokenRow[]>();
	for (let row of props.rows) {
		let name = row.group ?? "Other";
		let group = groups.get(name) ?? [];
		group.push(row);
		groups.set(name, group);
	}
	return (
		<div className="cv-token-list">
			{Array.from(groups, ([group, rows]) => (
				<section className="cv-token-group" key={group}>
					<h3>{group}</h3>
					{rows.map(row => <TokenItem {...props} key={row.name} row={row} />)}
				</section>
			))}
		</div>
	);
}
