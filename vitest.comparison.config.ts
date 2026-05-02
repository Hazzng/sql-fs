import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["comparison/**/*.comparison.test.ts"],
		setupFiles: ["comparison/vitest.setup.ts"],
		testTimeout: 60_000,
		hookTimeout: 30_000,
		passWithNoTests: true,
	},
});
