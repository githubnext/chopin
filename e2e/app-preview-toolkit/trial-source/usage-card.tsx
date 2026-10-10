import type { CSSProperties } from "react";
import { useUnits } from "./providers";

export type Usage = { service: string; used: number; limit: number; period: string };

export function UsageCard({
	usage,
	meterThickness,
	accent,
}: { usage: Usage; meterThickness?: number; accent?: string }) {
	let units = useUnits();
	let percentage = Math.round(usage.used / usage.limit * 100);
	let format = new Intl.NumberFormat("en-GB");
	let style = {
		...(meterThickness === undefined ? {} : { "--usage-meter-thickness": `${meterThickness}px` }),
		...(accent === undefined ? {} : { "--usage-accent": accent }),
	} as CSSProperties;
	return (
		<article className="usage-card" aria-label={`${usage.service} usage`} style={style}>
			<header>
				<span className="usage-eyebrow">Relay / {usage.period}</span>
				<h1>{usage.service}</h1>
			</header>
			<p className="usage-total">
				<strong>{format.format(usage.used)}</strong> / {format.format(usage.limit)} {units}
			</p>
			<div
				className="usage-meter"
				role="meter"
				aria-label="Monthly usage"
				aria-valuemin={0}
				aria-valuemax={usage.limit}
				aria-valuenow={usage.used}
			>
				<div className="usage-meter-fill" style={{ width: `${percentage}%` }} />
			</div>
			<footer>
				<span>{percentage}% used</span>
				<span>Renews 1 November</span>
			</footer>
		</article>
	);
}
