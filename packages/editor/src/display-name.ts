/** How a person is named beside their face, in comments and in Chat. */
export function displayName(handle: string): string {
	return handle ? handle[0]!.toUpperCase() + handle.slice(1) : handle;
}
