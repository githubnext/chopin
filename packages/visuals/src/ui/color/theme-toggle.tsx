import type { Theme } from "@chopin/color";

export type ThemeToggleProps = { value: Theme; onChange(theme: Theme): void };

export function ThemeToggle({ value, onChange }: ThemeToggleProps) {
	return (
		<div aria-label="Theme" className="cv-theme-toggle" role="group">
			{(["light", "dark"] as const).map(theme => (
				<button
					aria-pressed={value === theme}
					key={theme}
					onClick={() => onChange(theme)}
					type="button"
				>
					{theme === "light" ? "Light" : "Dark"}
				</button>
			))}
		</div>
	);
}
