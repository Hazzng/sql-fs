import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/fs/sql-fs/schema.ts",
	out: "./src/fs/sql-fs/migrations/postgres",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL!,
	},
});
