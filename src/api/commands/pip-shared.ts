/**
 * The handful of things the installer's two halves both need: the error type
 * every refusal is raised as, and the sandbox paths packages live under.
 *
 * It exists to keep `pip-command.ts` (resolution, fetch, the python3 override,
 * the command factory) and `pip-packages.ts` (blob/manifest/ledger work) free
 * of an import cycle.
 */

/** Where installed package trees live inside the sandbox. */
export const SITE_PACKAGES = "/site-packages";

/** Where the synthetic `requests` compatibility overlay is written. */
export const COMPAT_PACKAGES = `${SITE_PACKAGES}/_sqlfs_compat`;

/** Every deliberate installer refusal. Rendered as `pip: <message>`. */
export class PipError extends Error {
	readonly code = "PIP_EXPERIMENT_ERROR";
}

export function fail(message: string): never {
	throw new PipError(message);
}

/** One wheel the installer intends to make available, keyed by its own hash. */
export interface WheelTarget {
	readonly name: string;
	readonly version: string;
	/** Lowercase hex sha256 of the `.whl`, as PyPI declares it. */
	readonly sha256: string;
}
