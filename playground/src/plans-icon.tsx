import type { SVGProps } from "react";

// doc-arrow from icons/plans, drawn on the 16px Octicon grid.
let d =
	"M3.75 0L12.25 0A1.75 1.75 0 0 1 14 1.75L14 7.672L13.664 7.336A2 2 0 0 0 12.5 6.766L12.5 1.75A0.25 0.25 0 0 0 12.25 1.5L3.75 1.5A0.25 0.25 0 0 0 3.5 1.75L3.5 14.25A0.25 0.25 0 0 0 3.75 14.5L10.266 14.5A2 2 0 0 0 10.689 16L3.75 16A1.75 1.75 0 0 1 2 14.25L2 1.75A1.75 1.75 0 0 1 3.75 0ZM10.25 3.5A0.75 0.75 0 0 1 11 4.25A0.75 0.75 0 0 1 10.25 5L5.75 5A0.75 0.75 0 0 1 5 4.25A0.75 0.75 0 0 1 5.75 3.5L10.25 3.5ZM5.75 6.5L9.25 6.5A0.75 0.75 0 0 1 10 7.25A0.75 0.75 0 0 1 9.25 8L5.75 8A0.75 0.75 0 0 1 5 7.25A0.75 0.75 0 0 1 5.75 6.5ZM12.78 8.22L15.78 11.22A0.75 0.75 0 0 1 15.78 12.28L12.78 15.28A0.75 0.75 0 0 1 11.72 15.28A0.75 0.75 0 0 1 11.72 14.22L13.439 12.5L6.25 12.5A0.75 0.75 0 0 1 5.5 11.75A0.75 0.75 0 0 1 6.25 11L13.439 11L11.72 9.28A0.75 0.75 0 0 1 12.25 8A0.75 0.75 0 0 1 12.78 8.22Z";

type Props = Omit<SVGProps<SVGSVGElement>, "ref"> & {
	size?: number | "small" | "medium" | "large";
};

let sizes = { small: 16, medium: 32, large: 64 };

export default function PlansIcon({ size = 16, className, "aria-label": label, ...rest }: Props) {
	let px = typeof size === "number" ? size : sizes[size];
	return (
		<svg
			{...rest}
			viewBox="0 0 16 16"
			width={px}
			height={px}
			fill="currentColor"
			className={className ? `octicon ${className}` : "octicon"}
			aria-hidden={label ? undefined : true}
			aria-label={label}
			role={label ? "img" : undefined}
			focusable="false"
			display="inline-block"
			overflow="visible"
			style={{ verticalAlign: "text-bottom", ...rest.style }}
		>
			<path d={d} />
		</svg>
	);
}
