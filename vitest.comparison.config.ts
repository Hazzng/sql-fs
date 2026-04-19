import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/comparison-tests/**/*.comparison.test.ts"],
		setupFiles: ["src/comparison-tests/vitest.setup.ts"],
		testTimeout: 60_000,
		hookTimeout: 30_000,
		passWithNoTests: true,
	},
});
