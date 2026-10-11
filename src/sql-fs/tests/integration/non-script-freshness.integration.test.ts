import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";
import { requireMigratedSchema } from "./helpers/schema-preconditions.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Mutation gate timed out")), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe.skipIf(!process.env.DATABASE_URL)("non-script mutation freshness", () => {
	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL!);
	});

	it.each(["ingest", "composite write", "composite mkdir", "composite rm", "composite mv", "chmod"])(
		"rejects %s after an intervening commit and refreshes the next admission",
		async (operation) => {
			const sandboxId = `non-script-freshness-${randomUUID()}`;
			const writerDialect = new PostgresDialect(process.env.DATABASE_URL!);
			const staleDialect = new PostgresDialect(process.env.DATABASE_URL!);
			const writer = new SqlFs({ dialect: writerDialect, sandboxId });
			const stale = new SqlFs({ dialect: staleDialect, sandboxId });
			const reached = deferred();
			const release = deferred();
			let pending: Promise<unknown> | undefined;
			try {
				await writerDialect.connect();
				await staleDialect.connect();
				await writerDialect.transaction((tx) => writerDialect.createSandbox(tx, sandboxId));
				await writer.ready();
				await writer.writeFile("/value", "old");
				await writer.writeFile("/target", "unchanged");
				await stale.ready();
				await stale.ensureFresh();
				expect(await stale.readFile("/value")).toBe("old");

				const pause = async () => {
					reached.resolve();
					await release.promise;
				};
				if (operation === "composite write") {
					const write = staleDialect.writeFileComposite.bind(staleDialect);
					vi.spyOn(staleDialect, "writeFileComposite").mockImplementationOnce(async (...args) => {
						await pause();
						return write(...args);
					});
				} else if (operation === "composite mkdir") {
					const mkdir = staleDialect.mkdirComposite.bind(staleDialect);
					vi.spyOn(staleDialect, "mkdirComposite").mockImplementationOnce(async (...args) => {
						await pause();
						return mkdir(...args);
					});
				} else if (operation === "composite rm") {
					const rm = staleDialect.rmComposite.bind(staleDialect);
					vi.spyOn(staleDialect, "rmComposite").mockImplementationOnce(async (...args) => {
						await pause();
						return rm(...args);
					});
				} else if (operation === "composite mv") {
					const mv = staleDialect.mvComposite.bind(staleDialect);
					vi.spyOn(staleDialect, "mvComposite").mockImplementationOnce(async (...args) => {
						await pause();
						return mv(...args);
					});
				} else {
					const context = staleDialect.setSandboxContextWithLock.bind(staleDialect);
					vi.spyOn(staleDialect, "setSandboxContextWithLock").mockImplementationOnce(async (...args) => {
						await pause();
						await context(...args);
					});
				}
				const mutate = () => {
					if (operation === "composite write") return stale.writeFile("/attempt", "denied");
					if (operation === "composite mkdir") return stale.mkdir("/attempt");
					if (operation === "composite rm") return stale.rm("/target");
					if (operation === "composite mv") return stale.mv("/target", "/value");
					if (operation === "chmod") return stale.chmod("/target", 0o700);
					return stale.bulkIngest([{ path: "/attempt", content: new TextEncoder().encode("denied"), mode: 0o644 }]);
				};
				pending = mutate().then(
					() => undefined,
					(error: unknown) => error,
				);
				await bounded(
					Promise.race([reached.promise, pending.then(() => Promise.reject(new Error("Mutation did not reach gate")))]),
				);
				await writer.writeFile("/value", "new");
				const committedEpoch = await writerDialect.transaction((tx) => writerDialect.getSandboxEpoch(tx, sandboxId));
				release.resolve();
				const failure = await bounded(pending);
				expect(failure).toMatchObject({ code: "ESTALE" });

				expect(await writerDialect.transaction((tx) => writerDialect.getSandboxEpoch(tx, sandboxId))).toBe(
					committedEpoch,
				);
				await writer.reload();
				expect(await writer.readFile("/value")).toBe("new");
				expect(await writer.readFile("/target")).toBe("unchanged");
				expect(await writer.exists("/attempt")).toBe(false);
				expect((await writer.stat("/target")).mode).toBe(0o644);
				await stale.ensureFresh();
				expect(await stale.readFile("/value")).toBe("new");
				expect(await stale.readFile("/target")).toBe("unchanged");
				expect(await stale.exists("/attempt")).toBe(false);
				expect((await stale.stat("/target")).mode).toBe(0o644);
			} finally {
				release.resolve();
				if (pending) await bounded(pending);
				await writerDialect.transaction(async (tx) => {
					await writerDialect.deleteSandbox(tx, sandboxId);
					await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${sandboxId}`;
				});
				await stale.disconnect();
				await writer.disconnect();
			}
		},
		15000,
	);
});
