import { posix } from "node:path";
import {
	Bash,
	type Command,
	type CommandContext,
	type ExecResult,
	type IFileSystem,
	decodeBytesToUtf8,
	defineCommand,
} from "just-bash";
import { type IPackageStore, asPackageStore } from "../../sql-fs/package-store.js";
import { pythonSlotAlreadyHeld } from "../python-slot-context.js";
import { packageLimits } from "./package-limits.js";
import {
	compareVersions,
	hasExplicitPrerelease,
	isPreOrDevRelease,
	parseSpecifierSet,
	versionSatisfies,
} from "./pep440.js";
import { type Requirement, parseRequirement, parseRequirementText } from "./pep508.js";
import {
	type IncomingWheel,
	StaleManifestError,
	formatFreeze,
	formatPackageList,
	publishInstall,
	uninstallPackage,
	warmContentCache,
} from "./pip-publish.js";
import { COMPAT_PACKAGES, PipError, SITE_PACKAGES, fail } from "./pip-shared.js";
import { type WheelLease, createInProcessWheelLease, createInstallBudget, prepareWheel } from "./pip-wheel-store.js";
import type { PypiFetch, PypiFetchRequestOptions, PypiFetchResult } from "./pypi-fetch.js";

const PYPI_JSON_ORIGIN = "https://pypi.org";
const PYPI_FILE_ORIGIN = "https://files.pythonhosted.org";
const PYTHON_SITE_PACKAGES = `/host${SITE_PACKAGES}`;
const PYTHON_COMPAT_PACKAGES = `/host${COMPAT_PACKAGES}`;
/** The CPython WASM runtime just-bash ships; `Requires-Python` is checked against it. */
const RUNTIME_PYTHON_VERSION = "3.13.2";

const utf8Decoder = new TextDecoder();

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface PipLimits {
	/** `PIP_MAX_WHEEL_BYTES`. */
	readonly maxDownloadBytes: number;
	readonly maxDependencies: number;
	readonly maxDependencyDepth: number;
	readonly maxRedirects: number;
	/** Cap for a single PyPI JSON response. */
	readonly maxMetadataBytes: number;
	/** Cumulative metadata caps for one `pip install` invocation. */
	readonly maxTotalMetadataBytes: number;
	readonly maxMetadataRequests: number;
	readonly maxMetadataCacheEntries: number;
	readonly maxCandidateVersions: number;
}

/**
 * Resolver-only knobs. The size limits Phase W and Phase P enforce all come
 * from `packageLimits()`; the single one kept here is the per-response download
 * cap the PyPI fetch loop needs.
 */
export function readPipLimits(): PipLimits {
	const shared = packageLimits();
	return {
		maxDownloadBytes: shared.maxWheelBytes,
		maxDependencies: 64,
		maxDependencyDepth: envNumber("PIP_MAX_DEPENDENCY_DEPTH", 16),
		maxRedirects: 5,
		maxMetadataBytes: envNumber("PIP_MAX_METADATA_RESPONSE_BYTES", 16 * 1024 * 1024),
		maxTotalMetadataBytes: envNumber("PIP_MAX_METADATA_BYTES", 32 * 1024 * 1024),
		maxMetadataRequests: envNumber("PIP_MAX_METADATA_REQUESTS", 200),
		maxMetadataCacheEntries: envNumber("PIP_MAX_METADATA_CACHE_ENTRIES", 200),
		maxCandidateVersions: 64,
	};
}

/**
 * Version the synthetic `requests` provider declares. A `requests`
 * requirement is satisfied without any download when its specifier admits
 * this version; the shim's own `Requires-Dist` closure (urllib3,
 * charset-normalizer, idna, certifi) is never followed, because none of it is
 * importable in the WASM runtime and none of it is reachable through the shim.
 *
 * The shim implements `request`, `get`, `head`, `Session`, `Response`,
 * `HTTPBasicAuth` and `exceptions` over `jb_http`. A package that reaches for
 * anything else in `requests` (streaming, adapters, cookies, `post`) fails at
 * import or at call time, exactly as it does today; that is the documented
 * limit of the experiment, not something the resolver can detect.
 */
export const SYNTHETIC_REQUESTS_VERSION = "2.31.0";

/**
 * The current PyPI requests wheel imports urllib3 during module import. That
 * wheel's Emscripten support imports the unavailable `js` module before the
 * normal requests adapter can be installed. This small compatibility package
 * shadows requests only inside the sandbox and routes GET/HEAD through jb_http.
 */
const REQUESTS_COMPAT_FILES: Readonly<Record<string, string>> = {
	"requests/__init__.py": `
from urllib.parse import urlencode
import jb_http
from . import exceptions
from .auth import AuthBase, HTTPBasicAuth

__version__ = ${JSON.stringify(SYNTHETIC_REQUESTS_VERSION)}

class Request:
    def __init__(self, method, url, headers=None):
        self.method = method
        self.url = url
        self.headers = dict(headers or {})

class Response:
    def __init__(self, raw=None):
        self.status_code = 0
        self.reason = ''
        self.headers = {}
        self.url = ''
        self._content = b''
        self.encoding = 'utf-8'
        self.request = None
        if raw is not None:
            self.status_code = raw.status_code
            self.reason = raw.reason
            self.headers = raw.headers
            self.url = raw.url
            self._content = raw.content

    @property
    def content(self):
        return self._content

    @property
    def text(self):
        return self._content.decode(self.encoding or 'utf-8', errors='replace')

    @property
    def ok(self):
        return 200 <= self.status_code < 400

    def json(self):
        import json
        return json.loads(self.text)

    def raise_for_status(self):
        if not self.ok:
            raise exceptions.HTTPError('HTTP {}: {}'.format(self.status_code, self.reason), response=self)

class Session:
    def __init__(self):
        self.auth = None

    def mount(self, _prefix, _adapter):
        return None

    def request(self, method, url, params=None, data=None, headers=None, files=None, auth=None, **_kwargs):
        method = method.upper()
        if method not in ('GET', 'HEAD'):
            raise exceptions.RequestException('SQL-FS Databricks transport permits only GET/HEAD requests')
        if files:
            raise exceptions.RequestException('multipart requests are unsupported by the WASM HTTP adapter')
        if params:
            query = urlencode(params, doseq=True)
            url = url + ('&' if '?' in url else '?') + query
        request_obj = Request(method, url, headers)
        selected_auth = auth if auth is not None else self.auth
        if selected_auth is not None:
            request_obj = selected_auth(request_obj)
        response = Response(jb_http.request(method, url, headers=request_obj.headers, data=data))
        response.request = request_obj
        return response

    def get(self, url, **kwargs):
        return self.request('GET', url, **kwargs)

    def head(self, url, **kwargs):
        return self.request('HEAD', url, **kwargs)

    def close(self):
        return None

def request(method='GET', url=None, **kwargs):
    return Session().request(method, url, **kwargs)

def get(url, **kwargs):
    return request('GET', url, **kwargs)

def head(url, **kwargs):
    return request('HEAD', url, **kwargs)
`,
	"requests/exceptions.py": `
class RequestException(Exception):
    pass

class HTTPError(RequestException):
    def __init__(self, message='', response=None):
        super().__init__(message)
        self.response = response
`,
	"requests/auth.py": `
import base64

class AuthBase:
    def __call__(self, request):
        return request

class HTTPBasicAuth(AuthBase):
    def __init__(self, username, password):
        self.username = username
        self.password = password

    def __call__(self, request):
        encoded = '{}:{}'.format(self.username, self.password).encode()
        request.headers['Authorization'] = 'Basic ' + base64.b64encode(encoded).decode()
        return request
`,
	"requests/adapters.py":
		"class HTTPAdapter:\n    def __init__(self, *args, **kwargs):\n        self.max_retries = kwargs.get('max_retries')\n\n    def close(self):\n        return None\n",
	"requests/models.py": "from . import Response\n",
	"requests/sessions.py": "from . import Session\n",
	"requests/structures.py": `
class CaseInsensitiveDict(dict):
    def __init__(self, data=None, **kwargs):
        super().__init__()
        self.update(data or {}, **kwargs)

    def __setitem__(self, key, value):
        super().__setitem__(key.lower(), value)

    def __getitem__(self, key):
        return super().__getitem__(key.lower())

    def __contains__(self, key):
        return super().__contains__(key.lower())

    def get(self, key, default=None):
        return super().get(key.lower(), default)
`,
	"requests/utils.py": "def get_netrc_auth(_url):\n    return None\n",
	"requests/packages/__init__.py": "",
	"requests/packages/urllib3/__init__.py": "",
	"requests/packages/urllib3/exceptions.py": "class InsecureRequestWarning(Warning):\n    pass\n",
	"requests/packages/urllib3/poolmanager.py":
		"class PoolManager:\n    def __init__(self, *args, **kwargs):\n        pass\n",
	"requests/packages/urllib3/util/__init__.py": "",
	"requests/packages/urllib3/util/retry.py": `
class Retry:
    DEFAULT_ALLOWED_METHODS = frozenset(['HEAD', 'GET', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'])
    def __init__(self, *args, **kwargs):
        pass
`,
	// PyJWT eagerly imports jwks_client, which imports the unavailable WASM
	// _ssl extension. The legacy CLI only needs decode() for optional OAuth
	// refresh-token handling; token-authenticated read-only calls do not use it.
	"jwt/__init__.py": `
class InvalidTokenError(Exception):
    pass

PyJWTError = InvalidTokenError

def decode(_token, options=None, **_kwargs):
    return {}
`,
	// Keep the WASM socket restriction intact. databricks-cli only reads this
	// constant while constructing its unused urllib3 adapter.
	"ssl.py": "PROTOCOL_TLSv1_2 = 5\n",
};

/** Prefix added to every package-enabled python3 invocation. */
const PYTHON_PACKAGE_BOOTSTRAP = `
import sys as _sqlfs_sys
for _sqlfs_path in (${JSON.stringify(PYTHON_SITE_PACKAGES)}, ${JSON.stringify(PYTHON_COMPAT_PACKAGES)}):
    if _sqlfs_path not in _sqlfs_sys.path:
        _sqlfs_sys.path.insert(0, _sqlfs_path)

# requests uses urllib3 sockets, which are deliberately unavailable in the
# WASM runtime. Keep the socket restriction and adapt requests to jb_http.
try:
    import os as _sqlfs_os
    # Nothing has been installed, so there is no requests to adapt. Bail out
    # before paying a failed sys.path search on every python3 invocation.
    if not _sqlfs_os.path.isdir(${JSON.stringify(PYTHON_SITE_PACKAGES)}):
        raise ImportError("no installed packages")
    import requests as _sqlfs_requests
    import requests.models as _sqlfs_models
    import requests.sessions as _sqlfs_sessions
    from requests.structures import CaseInsensitiveDict as _sqlfs_case_insensitive
    import jb_http as _sqlfs_http
    from urllib.parse import urlencode as _sqlfs_urlencode

    def _sqlfs_request(session, method, url, params=None, data=None, headers=None, files=None, **kwargs):
        if method.upper() not in ("GET", "HEAD"):
            raise RuntimeError("SQL-FS Databricks transport permits only read-only GET/HEAD requests")
        if files:
            raise RuntimeError("SQL-FS Databricks transport does not support multipart requests")
        if params:
            _sqlfs_query = _sqlfs_urlencode(params, doseq=True)
            url = url + ("&" if "?" in url else "?") + _sqlfs_query
        if isinstance(data, dict):
            data = _sqlfs_urlencode(data, doseq=True)
        _sqlfs_response = _sqlfs_http.request(method.upper(), url, headers=headers, data=data)
        _sqlfs_result = _sqlfs_models.Response()
        _sqlfs_result.status_code = _sqlfs_response.status_code
        _sqlfs_result.reason = _sqlfs_response.reason
        _sqlfs_result.url = _sqlfs_response.url or url
        _sqlfs_result.headers = _sqlfs_case_insensitive(_sqlfs_response.headers)
        _sqlfs_result._content = _sqlfs_response.content
        _sqlfs_result.encoding = "utf-8"
        return _sqlfs_result

    _sqlfs_sessions.Session.request = _sqlfs_request
except ImportError:
    pass
`;

interface PyPIFile {
	readonly filename: string;
	readonly url: string;
	readonly packagetype: string;
	readonly yanked?: boolean | string;
	readonly requires_python?: string | null;
	readonly digests?: { readonly sha256?: string };
}

interface PyPIInfo {
	readonly version?: string;
	readonly requires_dist?: string[] | null;
	readonly requires_python?: string | null;
}

interface PyPIIndex {
	readonly info?: PyPIInfo;
	readonly releases?: Record<string, PyPIFile[]>;
	readonly urls?: PyPIFile[];
}

interface Artifact {
	readonly filename: string;
	readonly url: string;
	readonly sha256: string;
}

interface ResolvedPackage {
	readonly name: string;
	readonly version: string;
	readonly artifact: Artifact;
	readonly requiresDist: readonly string[];
}

interface ResolvedPlan {
	readonly packages: readonly ResolvedPackage[];
	/** Requirements satisfied by a built-in compatibility shim, never downloaded. */
	readonly synthetic: readonly { readonly name: string; readonly version: string }[];
}

/** Acquires a concurrency slot; resolves with the release function. */
export type SlotAcquire = (signal?: AbortSignal) => Promise<() => void>;

export interface PythonPackageCommandOptions {
	/** Pip-scoped fetch. Falls back to `ctx.fetch` when omitted. */
	readonly fetch?: PypiFetch;
	/** Bounds concurrent `pip install` orchestrations per replica. */
	readonly acquireInstall?: SlotAcquire;
	/** Bounds concurrent CPython WASM workers spawned by these commands. */
	readonly acquirePython?: SlotAcquire;
	/**
	 * Serialises Phase W per wheel hash. Defaults to a per-replica in-process
	 * singleflight; Phase 4 injects the Redis `withDistributedLock` version.
	 */
	readonly withWheelLease?: WheelLease;
	/**
	 * Blobs, manifests and the installed-package ledger for this sandbox.
	 *
	 * Injected rather than taken from `ctx.fs` because just-bash replaces
	 * `ctx.fs` with a defence-in-depth facade carrying only the `IFileSystem`
	 * methods whenever that layer is enabled; the facade would hide the store and
	 * `pip install` would report "requires a SQL backend" on a perfectly good
	 * Postgres sandbox. `ctx.fs` is still duck-typed as a fallback, which is what
	 * keeps the module usable without a `SessionManager`.
	 */
	readonly packageStore?: IPackageStore;
}

/**
 * The default wheel lease, shared by every command built without one so two
 * sandboxes on this replica installing the same wheel download it once.
 */
const sharedWheelLease: WheelLease = createInProcessWheelLease();

function isSupportedPureWheel(filename: string): boolean {
	if (!filename.endsWith(".whl")) return false;
	const parts = filename.slice(0, -4).split("-");
	if (parts.length < 5) return false;
	const pythonTags = parts.at(-3)!.split(".");
	const abi = parts.at(-2);
	const platform = parts.at(-1);
	return abi === "none" && platform === "any" && pythonTags.some((tag) => tag === "py3" || tag === "py2.py3");
}

/** True when the runtime's Python satisfies a `Requires-Python` value. */
function pythonSupported(requiresPython: string | null | undefined): boolean {
	if (!requiresPython || !requiresPython.trim()) return true;
	try {
		const specs = parseSpecifierSet(requiresPython, (reason) => {
			throw new Error(reason);
		});
		return versionSatisfies(RUNTIME_PYTHON_VERSION, specs);
	} catch {
		// An unparseable Requires-Python is not a reason to hide the release;
		// the import-time failure is clearer than a spurious "no wheel".
		return true;
	}
}

function artifactFromFiles(
	files: readonly PyPIFile[] | undefined,
	packageName: string,
	version: string,
): Artifact | undefined {
	const candidates = (files ?? []).filter((file) => !file.yanked);
	const pure = candidates.find(
		(file) =>
			file.packagetype === "bdist_wheel" &&
			isSupportedPureWheel(file.filename) &&
			pythonSupported(file.requires_python),
	);
	if (!pure) return undefined;
	const sha256 = pure.digests?.sha256;
	if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) fail(`PyPI did not provide a SHA-256 for ${packageName} ${version}`);
	return { filename: pure.filename, url: pure.url, sha256: sha256.toLowerCase() };
}

function isPypiUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			(url.origin === PYPI_JSON_ORIGIN || url.origin === PYPI_FILE_ORIGIN)
		);
	} catch {
		return false;
	}
}

function header(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Shared shape of `ctx.fetch` and the pip-scoped fetch. */
type AnyFetch = (url: string, options?: PypiFetchRequestOptions) => Promise<PypiFetchResult>;

interface ResolveState {
	readonly ctx: CommandContext;
	readonly fetch: AnyFetch;
	readonly limits: PipLimits;
	readonly cache: Map<string, PyPIIndex>;
	metadataBytes: number;
	metadataRequests: number;
}

async function fetchPypi(
	state: ResolveState,
	url: string,
	json: boolean,
	label: string,
): Promise<PypiFetchResult | undefined> {
	if (!isPypiUrl(url)) fail("refusing a PyPI URL outside pypi.org/files.pythonhosted.org");
	const limit = json ? state.limits.maxMetadataBytes : state.limits.maxDownloadBytes;
	let current = url;
	for (let redirect = 0; redirect <= state.limits.maxRedirects; redirect++) {
		let response: PypiFetchResult;
		try {
			response = await state.fetch(current, {
				followRedirects: false,
				timeoutMs: 30_000,
				signal: state.ctx.signal,
			});
		} catch (error) {
			// The shared `ctx.fetch` and the pip-scoped fetch both raise an error
			// named ResponseTooLargeError; surface the package and the number
			// instead of the generic "package installation failed".
			if (error instanceof Error && error.name === "ResponseTooLargeError") {
				fail(`${label} exceeds the ${limit} byte response limit`);
			}
			throw error;
		}
		if (response.status >= 300 && response.status < 400) {
			if (redirect === state.limits.maxRedirects) fail("PyPI download exceeded the redirect limit");
			const location = header(response.headers, "location");
			if (!location) fail("PyPI returned a redirect without a location");
			try {
				current = new URL(location, current).toString();
			} catch {
				fail("PyPI returned an invalid redirect location");
			}
			if (!isPypiUrl(current)) fail("PyPI redirect leaves the approved package hosts");
			continue;
		}
		if (json && response.status === 404) return undefined;
		if (response.status < 200 || response.status >= 300) fail(`PyPI request failed with HTTP ${response.status}`);
		if (response.body.length > limit) {
			fail(json ? `${label} exceeds the ${limit} byte metadata limit` : `${label} exceeds the download limit`);
		}
		if (json) {
			state.metadataBytes += response.body.length;
			if (state.metadataBytes > state.limits.maxTotalMetadataBytes) {
				fail(
					`package metadata for this install exceeds ${state.limits.maxTotalMetadataBytes} bytes (PIP_MAX_METADATA_BYTES)`,
				);
			}
		}
		return response;
	}
	fail("PyPI redirect handling failed");
}

async function fetchJson(state: ResolveState, url: string, label: string): Promise<PyPIIndex | undefined> {
	const cached = state.cache.get(url);
	if (cached) return cached;
	if (++state.metadataRequests > state.limits.maxMetadataRequests) {
		fail(
			`package metadata requests for this install exceed ${state.limits.maxMetadataRequests} (PIP_MAX_METADATA_REQUESTS)`,
		);
	}
	const response = await fetchPypi(state, url, true, label);
	if (!response) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8Decoder.decode(response.body));
	} catch {
		fail("PyPI returned invalid JSON");
	}
	if (!parsed || typeof parsed !== "object") fail("PyPI returned invalid JSON");
	const index = parsed as PyPIIndex;
	if (state.cache.size >= state.limits.maxMetadataCacheEntries) {
		fail(
			`package metadata cache for this install exceeds ${state.limits.maxMetadataCacheEntries} entries (PIP_MAX_METADATA_CACHE_ENTRIES)`,
		);
	}
	state.cache.set(url, index);
	return index;
}

/** The single pinned version of an `==x.y.z` requirement, when there is one. */
function pinnedVersion(requirement: Requirement): string | undefined {
	const equals = requirement.specs.filter((spec) => spec.operator === "==" && !spec.version.endsWith(".*"));
	if (equals.length !== 1) return undefined;
	const version = equals[0]!.version;
	return versionSatisfies(version, requirement.specs) ? version : undefined;
}

function noPureWheelMessage(name: string): string {
	return `${name} has no supported pure-Python py3-none-any wheel for the requested versions (sdists/native wheels are rejected)`;
}

async function selectPackage(state: ResolveState, requirement: Requirement): Promise<ResolvedPackage> {
	const encodedName = encodeURIComponent(requirement.name);
	// A pinned requirement only needs the one version's document; the full
	// release index for a popular project runs to megabytes.
	const pinned = pinnedVersion(requirement);
	if (pinned !== undefined) {
		const document = await fetchJson(
			state,
			`${PYPI_JSON_ORIGIN}/pypi/${encodedName}/${encodeURIComponent(pinned)}/json`,
			`${requirement.name} metadata`,
		);
		const artifact = document && artifactFromFiles(document.urls, requirement.name, pinned);
		if (document && artifact && pythonSupported(document.info?.requires_python)) {
			return {
				name: requirement.name,
				version: pinned,
				artifact,
				requiresDist: document.info?.requires_dist ?? [],
			};
		}
	}

	const index = await fetchJson(state, `${PYPI_JSON_ORIGIN}/pypi/${encodedName}/json`, `${requirement.name} metadata`);
	if (!index) fail(`PyPI has no project named '${requirement.name}'`);
	const allowPrerelease = hasExplicitPrerelease(requirement.specs);
	const releases = Object.keys(index.releases ?? {})
		.filter((version) => versionSatisfies(version, requirement.specs))
		.filter((version) => allowPrerelease || !isPreOrDevRelease(version))
		.sort((left, right) => compareVersions(right, left));
	if (releases.length === 0) fail(`no PyPI release satisfies '${requirement.raw}'`);
	let inspected = 0;
	for (const version of releases) {
		if (inspected >= state.limits.maxCandidateVersions) {
			// Report the real reason: every inspected release was native-only or
			// excluded by Requires-Python, which the counter would otherwise mask.
			fail(noPureWheelMessage(requirement.name));
		}
		inspected++;
		const artifact = artifactFromFiles(index.releases?.[version], requirement.name, version);
		if (!artifact) continue;
		if (version === index.info?.version) {
			if (!pythonSupported(index.info?.requires_python)) continue;
			return { name: requirement.name, version, artifact, requiresDist: index.info?.requires_dist ?? [] };
		}
		const metadata = await fetchJson(
			state,
			`${PYPI_JSON_ORIGIN}/pypi/${encodedName}/${encodeURIComponent(version)}/json`,
			`${requirement.name} ${version} metadata`,
		);
		if (!metadata) continue;
		if (!pythonSupported(metadata.info?.requires_python)) continue;
		return { name: requirement.name, version, artifact, requiresDist: metadata.info?.requires_dist ?? [] };
	}
	fail(noPureWheelMessage(requirement.name));
}

async function resolvePlan(state: ResolveState, roots: readonly Requirement[]): Promise<ResolvedPlan> {
	const constraints = new Map<string, Requirement[]>();
	const depths = new Map<string, number>();
	const children = new Map<string, Set<string>>();
	const resolved = new Map<string, ResolvedPackage>();
	const expandedExtras = new Map<string, string>();
	const synthetic = new Map<string, string>();
	const pending: string[] = [];
	const limits = state.limits;

	/**
	 * Depth is the longest path from a root, recomputed transitively whenever an
	 * edge lengthens one. Without the propagation a diamond (`A→B→C` and
	 * `A→D→E→…→C`) could register C at depth 1 and then expand its whole subtree
	 * under that stale depth, walking straight past `maxDependencyDepth`.
	 */
	const setDepth = (name: string, depth: number): void => {
		const current = depths.get(name);
		if (current !== undefined && current >= depth) return;
		depths.set(name, depth);
		if (depth > limits.maxDependencyDepth) fail(`dependency depth exceeds ${limits.maxDependencyDepth} at ${name}`);
		for (const child of children.get(name) ?? []) setDepth(child, depth + 1);
	};

	for (const root of roots) {
		constraints.set(root.name, [...(constraints.get(root.name) ?? []), root]);
		setDepth(root.name, 0);
		pending.push(root.name);
	}

	let processed = 0;
	while (pending.length) {
		const name = pending.shift()!;
		if (++processed > limits.maxDependencies * 4)
			fail("could not resolve the requested packages within the work limit");
		const requirements = constraints.get(name) ?? [];
		const extras = [...new Set(requirements.flatMap((requirement) => requirement.extras))].sort();
		const merged: Requirement = {
			name,
			extras,
			specs: requirements.flatMap((requirement) => requirement.specs),
			raw: requirements.map((requirement) => requirement.raw).join(", "),
		};

		if (name === "requests") {
			if (!versionSatisfies(SYNTHETIC_REQUESTS_VERSION, merged.specs)) {
				fail(
					`the sandbox provides requests ${SYNTHETIC_REQUESTS_VERSION} through its jb_http compatibility shim, which does not satisfy '${merged.raw}'`,
				);
			}
			if (extras.length > 0) {
				fail(
					`the built-in requests ${SYNTHETIC_REQUESTS_VERSION} shim provides no extras (requested '${extras.join(",")}')`,
				);
			}
			synthetic.set(name, SYNTHETIC_REQUESTS_VERSION);
			continue;
		}

		const candidate = await selectPackage(state, merged);
		const signature = extras.join(",");
		const previous = resolved.get(name);
		if (previous?.version === candidate.version && expandedExtras.get(name) === signature) continue;
		resolved.set(name, candidate);
		expandedExtras.set(name, signature);
		if (resolved.size > limits.maxDependencies) fail(`dependency count exceeds ${limits.maxDependencies}`);

		const childSet = children.get(name) ?? new Set<string>();
		children.set(name, childSet);
		for (const rawDependency of candidate.requiresDist) {
			// A dependency is included when it applies to the base set or to any
			// extra that was requested of this package.
			let dependency: Requirement | undefined;
			for (const extra of ["", ...extras]) {
				dependency = parseRequirement(rawDependency, extra, fail);
				if (dependency) break;
			}
			if (!dependency) continue;
			const list = constraints.get(dependency.name) ?? [];
			list.push(dependency);
			constraints.set(dependency.name, list);
			childSet.add(dependency.name);
			setDepth(dependency.name, (depths.get(name) ?? 0) + 1);
			pending.push(dependency.name);
		}
	}

	return {
		packages: [...resolved.values()].sort((left, right) => left.name.localeCompare(right.name)),
		synthetic: [...synthetic.entries()]
			.map(([name, version]) => ({ name, version }))
			.sort((left, right) => left.name.localeCompare(right.name)),
	};
}

async function writeRequestsCompat(ctx: CommandContext): Promise<void> {
	for (const [relativePath, content] of Object.entries(REQUESTS_COMPAT_FILES)) {
		const slash = relativePath.lastIndexOf("/");
		const directory = slash < 0 ? COMPAT_PACKAGES : `${COMPAT_PACKAGES}/${relativePath.slice(0, slash)}`;
		await ctx.fs.mkdir(directory, { recursive: true });
		await ctx.fs.writeFile(`${COMPAT_PACKAGES}/${relativePath}`, content);
	}
}

/** Fetches one wheel's bytes. Phase W owns everything that happens next. */
async function downloadWheel(state: ResolveState, packageInfo: ResolvedPackage): Promise<Uint8Array> {
	const response = await fetchPypi(state, packageInfo.artifact.url, false, `wheel ${packageInfo.name}`);
	if (!response) fail(`PyPI did not serve the wheel for ${packageInfo.name}`);
	return response.body;
}

const NO_STORE = "pip: package management requires a SQL backend; this sandbox's filesystem has no package store";

/** The injected store, or the one `ctx.fs` carries when nothing was injected. */
function resolveStore(ctx: CommandContext, options: PythonPackageCommandOptions): IPackageStore | undefined {
	return options.packageStore ?? asPackageStore(ctx.fs);
}

/**
 * Resolve (Phase R), make every wheel durable and reusable (Phase W), then
 * publish once into the sandbox (Phase P). No CPython worker is spawned
 * anywhere on this path.
 */
async function install(
	ctx: CommandContext,
	specs: readonly string[],
	options: PythonPackageCommandOptions,
): Promise<ExecResult> {
	const fetchFn = (options.fetch ?? ctx.fetch) as AnyFetch | undefined;
	if (!fetchFn) return commandFailure("pip: network access is required; create the sandbox with network:true", 1);
	if (specs.length === 0) return commandFailure("pip: install requires at least one package", 2);
	const store = resolveStore(ctx, options);
	if (!store) return commandFailure(NO_STORE, 1);
	const limits = readPipLimits();
	const sizeLimits = packageLimits();
	try {
		const roots: Requirement[] = [];
		for (const spec of specs) {
			const parsed = parseRequirementText(spec, fail);
			if (!parsed) return commandFailure("pip: empty package specifier", 2);
			if (parsed.marker !== undefined)
				return commandFailure("pip: package markers are not supported for direct installs", 1);
			roots.push(parsed.requirement);
		}
		if (await ctx.fs.exists(SITE_PACKAGES)) {
			const rootStat = await ctx.fs.lstat(SITE_PACKAGES);
			if (!rootStat.isDirectory || rootStat.isSymbolicLink) fail("package directory is not a real directory");
		}
		const state: ResolveState = {
			ctx,
			fetch: fetchFn,
			limits,
			cache: new Map<string, PyPIIndex>(),
			metadataBytes: 0,
			metadataRequests: 0,
		};
		const plan = await resolvePlan(state, roots);

		// Phase W, one wheel at a time: at most one wheel buffer is live.
		const lease = options.withWheelLease ?? sharedWheelLease;
		const budget = createInstallBudget();
		const incoming: IncomingWheel[] = [];
		for (const packageInfo of plan.packages) {
			const manifest = await prepareWheel({
				store,
				target: { name: packageInfo.name, version: packageInfo.version, sha256: packageInfo.artifact.sha256 },
				limits: sizeLimits,
				budget,
				lease,
				download: () => downloadWheel(state, packageInfo),
			});
			incoming.push({ name: packageInfo.name, version: packageInfo.version, wheelSha256: manifest.wheelSha256 });
		}

		const compatOverlay = plan.synthetic.some((item) => item.name === "requests")
			? () => writeRequestsCompat(ctx)
			: undefined;
		const publishArgs = { ctx, store, incoming, limits: sizeLimits, ...(compatOverlay ? { compatOverlay } : {}) };
		let published: Awaited<ReturnType<typeof publishInstall>>;
		try {
			published = await publishInstall(publishArgs);
		} catch (error) {
			if (!(error instanceof StaleManifestError)) throw error;
			// A blob a manifest claimed is gone. Drop the manifest, redo Phase W
			// for exactly those wheels, and publish once more.
			for (const wheelHex of error.wheels) {
				const packageInfo = plan.packages.find((item) => item.artifact.sha256 === wheelHex);
				if (!packageInfo) fail("a package manifest went stale during the install; try again");
				try {
					await store.deleteManifest(new Uint8Array(Buffer.from(wheelHex, "hex")));
				} catch (deleteError) {
					// EMANIFESTINUSE means another sandbox still has this package
					// installed, so the row cannot go. Redoing Phase W below re-ingests
					// its blobs and rewrites its file rows, which is the actual repair.
					if ((deleteError as { code?: unknown }).code !== "EMANIFESTINUSE") throw deleteError;
				}
				await prepareWheel({
					store,
					target: { name: packageInfo.name, version: packageInfo.version, sha256: packageInfo.artifact.sha256 },
					limits: sizeLimits,
					budget: createInstallBudget(),
					lease,
					download: () => downloadWheel(state, packageInfo),
					force: true,
				});
			}
			published = await publishInstall(publishArgs);
		}

		// Reading the small interpreted files back through `readFile` fills the
		// content cache (and backfills Redis) so the first import is not paid
		// file by file.
		await warmContentCache(ctx, published.grafted);

		const reported = [...plan.packages, ...plan.synthetic]
			.map((item) => `${item.name}-${item.version}`)
			.sort()
			.join(" ");
		const prefix = published.notes.length > 0 ? `${published.notes.join("\n")}\n` : "";
		return { stdout: `${prefix}Successfully installed ${reported}\n`, stderr: "", exitCode: 0 };
	} catch (error) {
		if (error instanceof PipError) return commandFailure(`pip: ${error.message}`, 1);
		const detail = error instanceof Error && error.message ? error.message : String(error);
		return commandFailure(`pip: package installation failed: ${detail}`, 1);
	}
}

/** `pip uninstall NAME...`, `-y` accepted and ignored (nothing prompts here). */
async function uninstall(
	ctx: CommandContext,
	args: readonly string[],
	options: PythonPackageCommandOptions,
): Promise<ExecResult> {
	const store = resolveStore(ctx, options);
	if (!store) return commandFailure(NO_STORE, 1);
	const names = args.filter((arg) => arg !== "-y" && arg !== "--yes");
	if (names.some((name) => name.startsWith("-")))
		return commandFailure("pip: uninstall options are not supported; use package names only", 2);
	if (names.length === 0) return commandFailure("pip: uninstall requires at least one package", 2);
	const lines: string[] = [];
	try {
		for (const name of names) {
			const result = await uninstallPackage(ctx, store, name);
			if (result.removed === undefined) return commandFailure(`pip: package '${name}' is not installed`, 1);
			lines.push(...result.notes, `Successfully uninstalled ${result.removed.name}-${result.removed.version}`);
		}
	} catch (error) {
		if (error instanceof PipError) return commandFailure(`pip: ${error.message}`, 1);
		const detail = error instanceof Error && error.message ? error.message : String(error);
		return commandFailure(`pip: uninstall failed: ${detail}`, 1);
	}
	return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
}

/** `pip list` and `pip freeze` read the ledger and nothing else. */
async function listInstalled(
	ctx: CommandContext,
	freeze: boolean,
	options: PythonPackageCommandOptions,
): Promise<ExecResult> {
	const store = resolveStore(ctx, options);
	if (!store) return commandFailure(NO_STORE, 1);
	try {
		const rows = await store.listInstalledPackages();
		return { stdout: freeze ? formatFreeze(rows) : formatPackageList(rows), stderr: "", exitCode: 0 };
	} catch (error) {
		const detail = error instanceof Error && error.message ? error.message : String(error);
		return commandFailure(`pip: could not read the installed-package ledger: ${detail}`, 1);
	}
}

const SUPPORTED_SUBCOMMANDS = "pip: only 'install', 'uninstall', 'list' and 'freeze' are supported by this experiment";

async function executePip(
	args: string[],
	ctx: CommandContext,
	options: PythonPackageCommandOptions,
): Promise<ExecResult> {
	if (args[0] === "--version" || args[0] === "-V")
		return { stdout: "sql-fs experimental pip (pure-Python wheels only)\n", stderr: "", exitCode: 0 };
	if (args[0] === "uninstall") return uninstall(ctx, args.slice(1), options);
	if (args[0] === "list") return listInstalled(ctx, false, options);
	if (args[0] === "freeze") return listInstalled(ctx, true, options);
	if (args[0] !== "install") return commandFailure(SUPPORTED_SUBCOMMANDS, 2);
	const packages = args.slice(1);
	if (packages.some((item) => item.startsWith("-")))
		return commandFailure("pip: install options are not supported; use package specifiers only", 2);
	// The admission slot covers the whole orchestration — resolution and every
	// wheel — because the transient memory of an install is held across all of
	// it, not only during one wheel.
	const release = options.acquireInstall ? await acquireOrFail(options.acquireInstall, ctx) : undefined;
	if (release === false) return commandFailure("pip: too many concurrent installs; try again shortly", 1);
	try {
		return await install(ctx, packages, options);
	} finally {
		release?.();
	}
}

async function acquireOrFail(acquire: SlotAcquire, ctx: CommandContext): Promise<(() => void) | false> {
	try {
		return await acquire(ctx.signal);
	} catch {
		return false;
	}
}

function commandFailure(message: string, exitCode = 127): ExecResult {
	return { stdout: "", stderr: `${message}\n`, exitCode };
}

function inheritedEnvironment(ctx: CommandContext): Record<string, string> {
	const env: Record<string, string> = Object.create(null);
	for (const [key, value] of ctx.env) env[key] = value;
	return env;
}

const DATABRICKS_SECRET_KEYS = ["DATABRICKS_TOKEN", "DATABRICKS_PASSWORD", "DATABRICKS_REFRESH_TOKEN"] as const;
/**
 * Below this length a "secret" is more likely to be a placeholder than a
 * credential, and redacting it would mangle unrelated output.
 */
const MIN_REDACTED_SECRET_LENGTH = 8;

function redactDatabricksResult(result: ExecResult, ctx: CommandContext): ExecResult {
	const secrets = DATABRICKS_SECRET_KEYS.map((key) => ctx.env.get(key)).filter(
		(value): value is string => typeof value === "string" && value.length >= MIN_REDACTED_SECRET_LENGTH,
	);
	if (secrets.length === 0) return result;
	const pattern = new RegExp(secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
	return {
		...result,
		stdout: result.stdout.replace(pattern, "[REDACTED]"),
		stderr: result.stderr.replace(pattern, "[REDACTED]"),
	};
}

async function getDatabricksEntrypoint(
	ctx: CommandContext,
): Promise<{ readonly moduleName: string; readonly functionName: string } | undefined> {
	const entrypointFiles = ctx.fs
		.getAllPaths()
		.filter((path) => path.startsWith(`${SITE_PACKAGES}/`) && path.endsWith(".dist-info/entry_points.txt"))
		.sort();
	for (const path of entrypointFiles) {
		const contents = await ctx.fs.readFile(path);
		const match = contents.match(/^\s*databricks\s*=\s*([A-Za-z_][A-Za-z0-9_.]*):([A-Za-z_][A-Za-z0-9_]*)\s*$/m);
		if (match) return { moduleName: match[1]!, functionName: match[2]! };
	}
	return undefined;
}

/**
 * A shell that still has just-bash's built-in `python` / `python3`.
 *
 * Custom commands take precedence over built-ins of the same name, and this
 * module overrides BOTH names (they must behave identically). `ctx.exec`
 * resolves through the same registry, so delegating there would re-enter this
 * command forever. A sibling `Bash` over the same filesystem, with no custom
 * commands, is the only route back to the built-in implementation that does
 * not depend on unexported internals.
 *
 * It is cached per filesystem — one warm shell per sandbox — and every exec
 * passes `replaceEnv` so nothing leaks from one invocation into the next.
 * just-bash queues CPython workers per filesystem, so the sibling shell shares
 * the sandbox's queue rather than adding a parallel one.
 */
const builtinPythonShells = new WeakMap<IFileSystem, Bash>();

function builtinPythonShell(ctx: CommandContext): Bash {
	const cached = builtinPythonShells.get(ctx.fs);
	if (cached) return cached;
	const shell = new Bash({ fs: ctx.fs, python: true, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
	builtinPythonShells.set(ctx.fs, shell);
	return shell;
}

/**
 * Runs the built-in WASM python. This is the point where a CPython worker is
 * actually spawned, so it is where the Python admission slot is taken. When
 * the enclosing exec already holds one (the script text matched
 * `PYTHON_INVOCATION_REGEX`), the acquire is a no-op: one exec must never
 * occupy two slots.
 */
async function invokeBuiltinPython(
	ctx: CommandContext,
	args: readonly string[],
	stdin: string,
	options: PythonPackageCommandOptions,
): Promise<ExecResult> {
	const run = async (): Promise<ExecResult> => {
		const result = await builtinPythonShell(ctx).exec("python", {
			cwd: ctx.cwd,
			args: [...args],
			stdin,
			env: inheritedEnvironment(ctx),
			replaceEnv: true,
			signal: ctx.signal,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
	};
	if (!options.acquirePython || pythonSlotAlreadyHeld()) return run();
	const release = await acquireOrFail(options.acquirePython, ctx);
	if (release === false) return commandFailure("python3: too many concurrent Python runs; try again shortly", 1);
	try {
		return await run();
	} finally {
		release();
	}
}

/** Runs the bootstrap, sets `sys.argv`, then hands control to `body`. */
function bootstrapProgram(argv: readonly string[], body: string): string[] {
	return ["-c", `${PYTHON_PACKAGE_BOOTSTRAP}\n_sqlfs_sys.argv = ${JSON.stringify(argv)}\n${body}`];
}

function runpyProgram(argv: readonly string[], runner: "run_module" | "run_path", target: string): string[] {
	return bootstrapProgram(
		argv,
		`import runpy as _sqlfs_runpy\n_sqlfs_runpy.${runner}(${JSON.stringify(target)}, run_name="__main__")`,
	);
}

/**
 * Maps a sandbox path to the path the CPython worker sees. The sandbox
 * filesystem is mounted at `/host` inside the worker, and `runpy.run_path`
 * reads the file through `io.open_code`, which the worker's path shim does not
 * rewrite — so an untranslated path is a `FileNotFoundError`.
 *
 * Idempotent: a path already under `/host` is returned unchanged, which is
 * also what makes this safe on just-bash 3.4.2, where the worker's own
 * `_should_redirect` skips `/host` paths.
 */
export function toWorkerPath(cwd: string, target: string): string {
	if (target === "/host" || target.startsWith("/host/")) return target;
	const absolute = target.startsWith("/") ? target : posix.join(cwd || "/", target);
	return `/host${posix.normalize(absolute)}`;
}

/** Interpreter options that consume the following argument. */
const VALUE_OPTIONS = new Set(["-W", "-X", "--check-hash-based-pycs"]);
/** Interpreter options that make python print and exit; the built-in handles them. */
const INFO_OPTIONS = new Set(["-V", "-VV", "--version", "-h", "--help", "--help-env", "--help-xoptions", "--help-all"]);

export type PythonInvocation =
	| { readonly kind: "interpreter" }
	| { readonly kind: "code"; readonly target: string; readonly rest: readonly string[] }
	| { readonly kind: "module"; readonly target: string; readonly rest: readonly string[] }
	| { readonly kind: "script"; readonly target: string; readonly rest: readonly string[] }
	| { readonly kind: "stdin"; readonly rest: readonly string[] };

/**
 * Parses a `python3` invocation, reading interpreter options only up to the
 * first positional argument. `python3 script.py --version` therefore runs the
 * script with `--version` in `sys.argv`, as CPython does, instead of printing
 * the interpreter version.
 */
export function parsePythonInvocation(args: readonly string[]): PythonInvocation | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "-") return { kind: "stdin", rest: args.slice(index + 1) };
		if (!arg.startsWith("-")) return { kind: "script", target: arg, rest: args.slice(index + 1) };
		if (arg === "--") {
			const script = args[index + 1];
			if (script === undefined) return { kind: "interpreter" };
			return { kind: "script", target: script, rest: args.slice(index + 2) };
		}
		if (INFO_OPTIONS.has(arg)) return { kind: "interpreter" };
		if (VALUE_OPTIONS.has(arg)) {
			if (args[index + 1] === undefined) return undefined;
			index++;
			continue;
		}
		if (arg === "-c" || arg === "-m") {
			const value = args[index + 1];
			if (value === undefined) return undefined;
			return {
				kind: arg === "-c" ? "code" : "module",
				target: value,
				rest: args.slice(index + 2),
			};
		}
		if (arg.startsWith("--")) continue;
		// A short-option cluster such as `-Bu`, `-uc CODE` or `-Xdev`.
		const letters = arg.slice(1);
		let consumedNext = false;
		let result: PythonInvocation | undefined;
		for (let position = 0; position < letters.length; position++) {
			const letter = letters[position]!;
			const remainder = letters.slice(position + 1);
			if (letter === "c" || letter === "m") {
				const value = remainder || args[index + 1];
				if (value === undefined) return undefined;
				if (!remainder) consumedNext = true;
				result = {
					kind: letter === "c" ? "code" : "module",
					target: value,
					rest: args.slice(index + (consumedNext ? 2 : 1)),
				};
				break;
			}
			if (letter === "W" || letter === "X") {
				if (!remainder && args[index + 1] === undefined) return undefined;
				if (!remainder) index++;
				break;
			}
			if (letter === "V" || letter === "h") return { kind: "interpreter" };
		}
		if (result) return result;
	}
	return { kind: "interpreter" };
}

/**
 * Rewrites a python3 invocation so installed packages are importable and so
 * script paths, `-m` modules and stdin programs all reach the worker intact.
 * Returns `undefined` when the invocation should be handed to the built-in
 * command untouched.
 */
export function packagePythonArgs(args: readonly string[], cwd: string, stdin: string): string[] | undefined {
	const invocation = parsePythonInvocation(args);
	if (!invocation || invocation.kind === "interpreter") return undefined;
	switch (invocation.kind) {
		case "code":
			return ["-c", `${PYTHON_PACKAGE_BOOTSTRAP}\n${invocation.target}`, ...invocation.rest];
		case "module":
			return runpyProgram([invocation.target, ...invocation.rest], "run_module", invocation.target);
		case "script":
			return runpyProgram([invocation.target, ...invocation.rest], "run_path", toWorkerPath(cwd, invocation.target));
		case "stdin":
			// 3.0.1's WorkerInput carries no stdin, so the program is read on the
			// host and handed to the worker as `-c` code instead.
			return [
				"-c",
				`${PYTHON_PACKAGE_BOOTSTRAP}\n_sqlfs_sys.argv = ${JSON.stringify(["-", ...invocation.rest])}\n${stdin}`,
			];
	}
}

/**
 * Builds the experimental package commands. Injecting the fetch and the two
 * admission slots keeps this module free of `SessionManager` imports and lets
 * tests count acquisitions.
 */
export function createPythonPackageCommands(options: PythonPackageCommandOptions = {}): Command[] {
	const pipCommand = defineCommand("pip", (args, ctx) => executePip(args, ctx, options));
	const pip3Command = defineCommand("pip3", (args, ctx) => executePip(args, ctx, options));

	const runPython = async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
		const stdin = decodeBytesToUtf8(ctx.stdin);
		const rewritten = packagePythonArgs(args, ctx.cwd, stdin);
		return invokeBuiltinPython(ctx, rewritten ?? args, stdin, options);
	};
	const python3Command = defineCommand("python3", runPython);
	// `python` and `python3` must behave identically: registering only one meant
	// `python -c "import databricks_cli"` failed while `python3 -c` worked.
	const pythonCommand = defineCommand("python", runPython);

	const databricksCommand = defineCommand("databricks", async (args, ctx): Promise<ExecResult> => {
		if (!ctx.fetch)
			return commandFailure("databricks: network access is disabled; create the sandbox with network:true");
		if (!ctx.exec) return commandFailure("databricks: WASM Python command is unavailable");
		const entrypoint = await getDatabricksEntrypoint(ctx);
		if (!entrypoint)
			return commandFailure("databricks: install databricks-cli first with 'pip install databricks-cli'");
		// Dispatch to the built-in python, not the python3 override, so the
		// bootstrap this program already carries is not prepended a second time.
		const program = bootstrapProgram(
			["databricks", ...args],
			[
				"import os as _sqlfs_databricks_os",
				'_sqlfs_databricks_os.environ["DATABRICKS_CLI_DO_NOT_EXECUTE_NEWER_VERSION"] = "1"',
				`from ${entrypoint.moduleName} import ${entrypoint.functionName} as _sqlfs_databricks_main`,
				"_sqlfs_databricks_main()",
			].join("\n"),
		);
		const result = await invokeBuiltinPython(ctx, program, decodeBytesToUtf8(ctx.stdin), options);
		return redactDatabricksResult(result, ctx);
	});

	return [pipCommand, pip3Command, python3Command, pythonCommand, databricksCommand];
}

/** Default registration with no injected fetch or admission slots. */
export const pythonPackageCommands = createPythonPackageCommands();
