import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		testTimeout: 30_000,
		hookTimeout: 15_000,
		passWithNoTests: true,
		exclude: ["**/node_modules/**", "**/dist/**", "src/comparison-tests/**/*.comparison.test.ts"],
	},
});
