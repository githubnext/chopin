import type { SVGProps } from "react";

// scroll-both from icons/plans/blueprint, drawn on the 16px Octicon grid.
let d =
	"M4.268 0.732Q4.816 1.281 4.954 2L11.046 2Q11.184 1.281 11.732 0.732A2.5 2.5 0 0 1 16 2.5L16 13.5A2.5 2.5 0 0 1 11.732 15.268Q11.184 14.719 11.046 14L4.954 14Q4.816 14.719 4.268 15.268A2.5 2.5 0 0 1 0 13.5L0 2.5A2.5 2.5 0 0 1 4.268 0.732ZM3.5 13.5L3.5 2.5A1 1 0 0 0 1.793 1.793A1 1 0 0 0 1.5 2.5L1.5 13.5A1 1 0 0 0 3.207 14.207A1 1 0 0 0 3.5 13.5ZM12.5 13.5A1 1 0 0 0 12.793 14.207A1 1 0 0 0 14.5 13.5L14.5 2.5A1 1 0 0 0 14.207 1.793A1 1 0 0 0 12.5 2.5L12.5 13.5ZM11 12.5L11 3.5L5 3.5L5 12.5L11 12.5ZM9.25 5.5A0.75 0.75 0 0 1 10 6.25A0.75 0.75 0 0 1 9.25 7L6.75 7A0.75 0.75 0 0 1 6 6.25A0.75 0.75 0 0 1 6.75 5.5L9.25 5.5ZM6.75 9L9.25 9A0.75 0.75 0 0 1 10 9.75A0.75 0.75 0 0 1 9.25 10.5L6.75 10.5A0.75 0.75 0 0 1 6 9.75A0.75 0.75 0 0 1 6.75 9Z";

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
