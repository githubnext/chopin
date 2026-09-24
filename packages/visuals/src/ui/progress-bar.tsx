import type { ComponentProps } from "react";

export type ProgressBarProps = Omit<ComponentProps<"span">, "children"> & {
	label: string;
	value: number;
};

export function ProgressBar({ className, label, value, ...props }: ProgressBarProps) {
	let normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 0;
	return (
		<span
			{...props}
			aria-label={label}
			aria-valuemax={100}
			aria-valuemin={0}
			aria-valuenow={normalized}
			className={["cv-progress-bar", className].filter(Boolean).join(" ")}
			data-slot="progress-bar"
			role="progressbar"
		>
			<span aria-hidden="true" className="cv-progress-bar-track">
				<span
					aria-hidden="true"
					className="cv-progress-bar-fill"
					style={{ width: `${normalized}%` }}
				/>
			</span>
			<span aria-hidden="true" className="cv-progress-bar-value">
				{normalized}%
			</span>
		</span>
	);
}
