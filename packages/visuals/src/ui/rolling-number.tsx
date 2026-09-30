import type { ComponentProps, CSSProperties } from "react";

export type RollingNumberProps = Omit<ComponentProps<"span">, "children"> & {
	format: Intl.NumberFormat;
	value: number;
};

type Part = { char: string; digit: boolean; key: string };

const DIGITS = [..."0123456789"];

function numberParts(value: number, format: Intl.NumberFormat): Part[] {
	let chars = format.formatToParts(value).flatMap(part =>
		[...part.value].map(char => ({
			char,
			digit: (part.type === "integer" || part.type === "fraction") && /\d/.test(char),
		}))
	);
	// Keys count from the right so the ones column keeps its identity, and keeps rolling, when the
	// number gains or loses a leading digit.
	return chars.map((part, index) => ({ ...part, key: String(chars.length - index) }));
}

export function RollingNumber({ className, format, value, ...props }: RollingNumberProps) {
	return (
		<span
			{...props}
			className={["cv-rolling-number", className].filter(Boolean).join(" ")}
			data-slot="rolling-number"
		>
			{/* Screen readers hear the formatted value once rather than ten digits per column. */}
			<span className="cv-rolling-number-label">{format.format(value)}</span>
			{numberParts(value, format).map(part =>
				part.digit
					? (
						<span aria-hidden="true" className="cv-rolling-number-digit" key={part.key}>
							<span
								className="cv-rolling-number-column"
								style={{ "--cv-rolling-digit": part.char } as CSSProperties}
							>
								{DIGITS.map(digit => <span key={digit}>{digit}</span>)}
							</span>
						</span>
					)
					: (
						<span aria-hidden="true" key={part.key}>
							{part.char}
						</span>
					)
			)}
		</span>
	);
}
