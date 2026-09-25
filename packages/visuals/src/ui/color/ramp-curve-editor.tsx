import { useId } from "react";

import { ChromaGraph } from "./chroma-graph";
import { ScrubField } from "./scrub-field";

import type { Curve, Endpoint, Oklch } from "@chopin/color";

export type RampCurveEditorProps = {
	steps: readonly string[];
	current: readonly Oklch[];
	curve: Curve;
	onCurveChange(curve: Curve): void;
	edited: boolean;
	onDiscard(): void;
};

export function RampCurveEditor({
	current,
	curve,
	onCurveChange,
	edited,
	onDiscard,
}: RampCurveEditorProps) {
	let id = useId();

	function update(which: keyof Curve, values: Partial<Endpoint>) {
		onCurveChange({ ...curve, [which]: { ...curve[which], ...values } });
	}

	return (
		<section aria-label="Ramp curve" className="cv-ramp-curve">
			{(["darkest", "lightest"] as const).map(which => {
				let endpoint = curve[which];
				let title = which === "darkest" ? "Darkest" : "Lightest";
				return (
					<div className="cv-ramp-endpoint" key={which}>
						<h3>{title}</h3>
						<div className="cv-ramp-controls">
							<ScrubField
								ariaLabel={`${title} lightness`}
								label="L"
								max={100}
								min={0}
								onChange={value => update(which, { l: value / 100 })}
								precision={0}
								step={1}
								suffix="%"
								value={endpoint.l * 100}
							/>
							<ScrubField
								ariaLabel={`${title} hue shift`}
								label="H"
								max={180}
								min={-180}
								onChange={value => update(which, { hueShift: value })}
								precision={0}
								step={1}
								suffix="°"
								value={endpoint.hueShift}
							/>
							<select
								aria-label={`${title} easing`}
								onChange={event =>
									update(which, {
										easing: event.target.value === `${id}-${which}-ease` ? "ease" : "linear",
									})}
								value={`${id}-${which}-${endpoint.easing}`}
							>
								<option value={`${id}-${which}-linear`}>Linear</option>
								<option value={`${id}-${which}-ease`}>Ease</option>
							</select>
						</div>
					</div>
				);
			})}
			<ChromaGraph values={current} />
			{edited && (
				<p className="cv-ramp-discard">
					This row&apos;s previous values were overwritten.{" "}
					<button onClick={onDiscard} type="button">Discard these changes</button> to restore them.
				</p>
			)}
		</section>
	);
}
