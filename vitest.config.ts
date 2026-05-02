import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		testTimeout: 30_000,
		hookTimeout: 15_000,
		passWithNoTests: true,
		setupFiles: ["./vitest.setup.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "comparison/**/*.comparison.test.ts"],
	},
});
