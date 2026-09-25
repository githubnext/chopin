import { sameColor, toHex } from "@chopin/color";
import { useState } from "react";

import { ColorField } from "./color-field";
import { ColorPlane } from "./color-plane";
import { ContrastReader } from "./contrast-reader";
import { HueStrip } from "./hue-strip";

import type { ColorFormat, Oklch } from "@chopin/color";
import type { ComponentProps, ReactNode } from "react";
import type { ContrastReaderProps } from "./contrast-reader";

export type ColorPopoverProps = Omit<ComponentProps<"section">, "onChange" | "title"> & {
	title: string;
	fieldKey?: string;
	value: Oklch;
	previous: Oklch;
	onChange(value: Oklch): void;
	contrast: Omit<ContrastReaderProps, "value" | "previous">;
	actions?: ReactNode;
};

/** Hue changes keep chroma: clamping would ratchet it down through narrow hues. */
export function withHue(value: Oklch, h: number): Oklch {
	return { ...value, h };
}

export function ColorPopover({
	title,
	fieldKey,
	value,
	previous,
	onChange,
	contrast,
	actions,
	className,
	...props
}: ColorPopoverProps) {
	let [form, setForm] = useState<ColorFormat>("oklch");
	let changed = !sameColor(value, previous);
	return (
		<section
			{...props}
			aria-label={title}
			className={["cv-color-popover", className].filter(Boolean).join(" ")}
		>
			<header className="cv-color-popover-header">
				<h3>{title}</h3>
				{actions && <div className="cv-color-popover-actions">{actions}</div>}
			</header>
			<div className="cv-color-popover-pickers">
				<ColorPlane onChange={onChange} value={value} />
				<HueStrip onChange={h => onChange(withHue(value, h))} value={value} />
			</div>
			<div className="cv-color-compare">
				<div aria-hidden="true" className="cv-color-compare-labels">
					<span>Previous</span>
					<span>Current</span>
				</div>
				<div className="cv-color-compare-bar">
					<button
						aria-label="Restore previous color"
						disabled={!changed}
						onClick={() => onChange(previous)}
						style={{ background: toHex(previous) }}
						type="button"
					/>
					<span style={{ background: toHex(value) }} />
				</div>
			</div>
			<ColorField
				format={form}
				key={fieldKey}
				onChange={onChange}
				onFormatChange={setForm}
				value={value}
			/>
			<ContrastReader {...contrast} previous={changed ? previous : undefined} value={value} />
		</section>
	);
}
