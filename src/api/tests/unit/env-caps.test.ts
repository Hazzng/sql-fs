/**
 * The write cap and the contentCache cap are coupled, and the coupling is a memory cliff rather
 * than a preference: a file the LRU accepts is retained once; one it rejects is retained twice,
 * and again per pool connection that read it. Load testing measured 50 MiB at 1.01x and 51 MiB at
 * 2.01x, so a 64 MiB write cap cost 256 MB per warm session for a full idle timeout.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_CACHE_MAX_BYTES } from "../../../sql-fs/sql-fs.js";
import { MAX_FILE_WRITE_BYTES } from "../../lib/env.js";

describe("write cap vs contentCache cap", () => {
	it("accepts no write larger than the cache can hold", () => {
		expect(MAX_FILE_WRITE_BYTES).toBeLessThanOrEqual(DEFAULT_CONTENT_CACHE_MAX_BYTES);
	});
});
