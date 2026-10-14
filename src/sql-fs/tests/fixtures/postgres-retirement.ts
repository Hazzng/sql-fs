import assert from "node:assert/strict";
import { PostgresDialect } from "../../dialects/postgres.js";
import type { SqlDialect } from "../../types.js";
import { deferred } from "../unit/freshness-helpers.js";

export function makePausedPostgresRetirement(epoch: { version: bigint }): {
	readonly blocked: ReturnType<typeof deferred<void>>;
	readonly resume: ReturnType<typeof deferred<void>>;
	readonly retire: NonNullable<SqlDialect<unknown>["retireSandboxGeneration"]>;
} {
	const dialect = new PostgresDialect("postgres://unused");
	const blocked = deferred();
	const resume = deferred();
	let pause = true;
	const retire: NonNullable<SqlDialect<unknown>["retireSandboxGeneration"]> = async (
		_tx,
		sandboxId,
		assertOwnerLease,
	) => {
		let locked = false;
		let context = false;
		const query = async (
			strings: TemplateStringsArray,
			...values: unknown[]
		): Promise<Array<{ epoch: string } | { prior_epoch: string; version: string }>> => {
			const sql = strings.join("?").replace(/\s+/g, " ").trim();
			switch (sql) {
				case "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))": {
					assert.deepEqual(values, [sandboxId]);
					if (pause) {
						pause = false;
						blocked.resolve();
						await resume.promise;
					}
					locked = true;
					return [];
				}
				case "SELECT set_config('app.sandbox_id', ?, true), set_config('app.sandbox_epoch', s.version::text, true), s.version AS epoch FROM sandboxes s WHERE s.id = ?": {
					assert.equal(locked, true);
					assert.deepEqual(values, [sandboxId, sandboxId]);
					context = true;
					return [{ epoch: String(epoch.version) }];
				}
				case "UPDATE sandboxes SET version = version + 1 WHERE id = ? RETURNING version - 1 AS prior_epoch, version": {
					assert.equal(locked && context, true);
					assert.deepEqual(values, [sandboxId]);
					const priorEpoch = epoch.version;
					epoch.version++;
					return [{ prior_epoch: String(priorEpoch), version: String(epoch.version) }];
				}
				default:
					throw new Error(`Unexpected retirement SQL: ${sql}`);
			}
		};
		return dialect.retireSandboxGeneration(query as never, sandboxId, assertOwnerLease);
	};
	return { blocked, resume, retire };
}
