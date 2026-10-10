/** Whether this server offers the living-document build; set once from the session. */
let enabled = false;

export function setLiveBuild(value: boolean | undefined): void {
	enabled = !!value;
}

export function liveBuildEnabled(): boolean {
	return enabled;
}
