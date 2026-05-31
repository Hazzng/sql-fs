import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/sql-fs/schema.ts",
	out: "./src/sql-fs/migrations/postgres",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL!,
	},
});
