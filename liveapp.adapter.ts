export default {
	sources: {
		include: ["apps/web/src/**", "packages/editor/src/**", "packages/visuals/**"],
		exclude: ["**/*.test.*", "**/*.e2e.*", "**/package.json", "apps/web/src/main.tsx"],
	},
	checks: [["bun", "run", "types"]],
};
