import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		testTimeout: 30_000,
		hookTimeout: 15_000,
		passWithNoTests: true,
		setupFiles: ["./vitest.setup.ts"],
		// Globs must stay path-independent: a git worktree checked out *inside* the
		// repo (Claude Code puts agent worktrees at .claude/worktrees/<id>/) carries
		// its own comparison/ and src/ copies, and a root-anchored "comparison/**"
		// misses them — sweeping the whole duplicate suite into every run (#180).
		exclude: ["**/node_modules/**", "**/dist/**", "**/comparison/**/*.comparison.test.ts", "**/.claude/**"],
	},
});
