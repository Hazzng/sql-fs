import { createHash } from "node:crypto";
import { type CommandContext, type ExecResult, decodeBytesToUtf8, defineCommand } from "just-bash";

const PYPI_JSON_ORIGIN = "https://pypi.org";
const PYPI_FILE_ORIGIN = "https://files.pythonhosted.org";
const SITE_PACKAGES = "/site-packages";
const COMPAT_PACKAGES = `${SITE_PACKAGES}/_sqlfs_compat`;
const PYTHON_SITE_PACKAGES = `/host${SITE_PACKAGES}`;
const PYTHON_COMPAT_PACKAGES = `/host${COMPAT_PACKAGES}`;
const TEMP_ROOT = "/tmp/.sqlfs-pip";

const utf8Decoder = new TextDecoder();

/** These limits are deliberately conservative for the experiment. */
const PIP_LIMITS = {
	maxDownloadBytes: 16 * 1024 * 1024,
	maxTotalDownloadBytes: 64 * 1024 * 1024,
	maxDependencies: 64,
	maxDependencyDepth: 16,
	maxWheelFiles: 10_000,
	maxExtractedBytes: 48 * 1024 * 1024,
	maxRedirects: 5,
	maxMetadataBytes: 4 * 1024 * 1024,
	maxCandidateVersions: 64,
} as const;

/**
 * This code runs in the just-bash CPython WASM worker. It is intentionally
 * small and uses zipfile rather than a host-side archive library: all reads
 * and writes go through the worker's virtual filesystem mount.
 */
const EXTRACT_CODE = `
import json
import os
import stat
import sys
import zipfile

wheel_path, destination, max_files, max_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
seen = set()
file_count = 0
total_bytes = 0

def fail(message):
    print(json.dumps({"error": message[:240]}))
    raise SystemExit(1)

try:
    with zipfile.ZipFile(wheel_path, "r") as archive:
        for info in archive.infolist():
            name = info.filename
            if not name or len(name) > 512 or "\\\\" in name or name.startswith("/"):
                fail("wheel contains an unsafe path")
            parts = name.rstrip("/").split("/")
            if any(part in ("", ".", "..") for part in parts):
                fail("wheel contains a zip path traversal")
            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                fail("wheel contains a symbolic link")
            if name in seen:
                fail("wheel contains duplicate paths")
            seen.add(name)
            if name.endswith("/"):
                continue
            file_count += 1
            if file_count > max_files:
                fail("wheel exceeds the extracted file limit")
            total_bytes += info.file_size
            if total_bytes > max_bytes:
                fail("wheel exceeds the extracted byte limit")
            target = os.path.join(destination, *parts)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(info, "r") as source, open(target, "wb") as output:
                remaining = info.file_size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        fail("wheel entry ended before its declared size")
                    output.write(chunk)
                    remaining -= len(chunk)
except zipfile.BadZipFile:
    fail("download is not a valid wheel ZIP")
except OSError as error:
    fail("wheel extraction failed: " + str(error))

print(json.dumps({"files": file_count, "bytes": total_bytes}))
`;

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
from .auth import AuthBase

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

type SecureFetch = NonNullable<CommandContext["fetch"]>;
type FetchResult = Awaited<ReturnType<SecureFetch>>;

interface PyPIFile {
	readonly filename: string;
	readonly url: string;
	readonly packagetype: string;
	readonly yanked?: boolean | string;
	readonly digests?: { readonly sha256?: string };
}

interface PyPIInfo {
	readonly version?: string;
	readonly requires_dist?: string[] | null;
}

interface PyPIIndex {
	readonly info?: PyPIInfo;
	readonly releases?: Record<string, PyPIFile[]>;
	readonly urls?: PyPIFile[];
}

interface Requirement {
	readonly name: string;
	readonly specs: readonly VersionSpec[];
	readonly raw: string;
}

interface VersionSpec {
	readonly operator: string;
	readonly version: string;
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

class PipError extends Error {
	readonly code = "PIP_EXPERIMENT_ERROR";
}

function fail(message: string): never {
	throw new PipError(message);
}

function normalizeName(name: string): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[-_.]+/g, "-");
	if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
		fail(`invalid package name '${name.slice(0, 80)}'`);
	}
	return normalized;
}

function splitOutsideQuotes(input: string, separator: string): string[] {
	const result: string[] = [];
	let start = 0;
	let depth = 0;
	let quote = "";
	for (let index = 0; index <= input.length - separator.length; index++) {
		const character = input[index];
		if (quote) {
			if (character === quote && input[index - 1] !== "\\") quote = "";
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "(") depth++;
		if (character === ")") depth--;
		if (depth === 0 && input.slice(index, index + separator.length).toLowerCase() === separator) {
			result.push(input.slice(start, index).trim());
			start = index + separator.length;
			index += separator.length - 1;
		}
	}
	result.push(input.slice(start).trim());
	return result.filter(Boolean);
}

function stripOuterParens(input: string): string {
	let value = input.trim();
	while (value.startsWith("(") && value.endsWith(")")) {
		let depth = 0;
		let closesAtEnd = true;
		let quote = "";
		for (let index = 0; index < value.length; index++) {
			const character = value[index];
			if (quote) {
				if (character === quote && value[index - 1] !== "\\") quote = "";
				continue;
			}
			if (character === "'" || character === '"') quote = character;
			else if (character === "(") depth++;
			else if (character === ")") {
				depth--;
				if (depth === 0 && index !== value.length - 1) {
					closesAtEnd = false;
					break;
				}
			}
		}
		if (!closesAtEnd) break;
		value = value.slice(1, -1).trim();
	}
	return value;
}

function markerValue(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function compareMarkerValue(left: string, right: string, identifier: string): number {
	if (identifier === "python_version" || identifier === "python_full_version") {
		return compareVersions(left, right);
	}
	return left.localeCompare(right);
}

/** PEP 508 marker variables as seen from the CPython WASM runtime. */
const MARKER_VALUES = Object.assign(Object.create(null) as Record<string, string>, {
	python_version: "3.13",
	python_full_version: "3.13.2",
	platform_python_implementation: "CPython",
	implementation_name: "cpython",
	sys_platform: "emscripten",
	platform_system: "Emscripten",
	os_name: "posix",
	platform_machine: "wasm32",
	extra: "",
});

function evaluateMarker(marker: string | undefined): boolean {
	if (!marker) return true;
	const expression = stripOuterParens(marker);
	const ors = splitOutsideQuotes(expression, " or ");
	if (ors.length > 1) return ors.some(evaluateMarker);
	const ands = splitOutsideQuotes(expression, " and ");
	if (ands.length > 1) return ands.every(evaluateMarker);
	const negated = expression.match(/^not\s+(.+)$/i);
	if (negated) return !evaluateMarker(negated[1]);

	const match = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(not\s+in|in|==|!=|<=|>=|<|>)\s*(.+)$/i);
	if (!match) fail(`unsupported dependency marker '${marker.slice(0, 120)}'`);
	const identifier = match[1]!;
	const operator = match[2]!;
	const rawRight = match[3]!;
	const left = MARKER_VALUES[identifier.toLowerCase()];
	if (left === undefined) fail(`unsupported dependency marker variable '${identifier}'`);
	const right = markerValue(rawRight);
	if (operator.toLowerCase() === "in" || operator.toLowerCase() === "not in") {
		const contained = right
			.split(",")
			.map((item) => item.trim())
			.includes(left);
		return operator.toLowerCase() === "in" ? contained : !contained;
	}
	const comparison = compareMarkerValue(left, right, identifier.toLowerCase());
	switch (operator) {
		case "==":
			return comparison === 0;
		case "!=":
			return comparison !== 0;
		case "<":
			return comparison < 0;
		case "<=":
			return comparison <= 0;
		case ">":
			return comparison > 0;
		case ">=":
			return comparison >= 0;
		default:
			fail(`unsupported dependency marker operator '${operator}'`);
	}
}

function parseRequirement(raw: string): Requirement | undefined {
	const withoutComment = raw.trim();
	if (!withoutComment) return undefined;
	const [requirementText = "", marker] = withoutComment.split(/\s*;\s*/, 2);
	if (!evaluateMarker(marker)) return undefined;
	const match = requirementText.match(/^([A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?)(?:\[([^\]]+)\])?\s*(.*)$/);
	if (!match) fail(`unsupported dependency '${raw.slice(0, 160)}'`);
	const rawName = match[1]!;
	const extras = match[2];
	const rawSpec = match[3]!;
	if (extras) fail(`package extras are not supported in '${raw.slice(0, 120)}'`);
	const specs: VersionSpec[] = [];
	for (const part of rawSpec
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)) {
		const specMatch = part.match(/^(===|~=|==|!=|<=|>=|<|>)\s*([A-Za-z0-9][A-Za-z0-9!+._-]*)(?:\.\*)?$/);
		if (!specMatch) fail(`unsupported version specifier '${part.slice(0, 80)}' in '${raw.slice(0, 120)}'`);
		specs.push({ operator: specMatch[1]!, version: specMatch[2]! + (part.endsWith(".*") ? ".*" : "") });
	}
	return { name: normalizeName(rawName), specs, raw };
}

interface ParsedVersion {
	readonly epoch: number;
	readonly release: readonly number[];
	readonly pre: readonly [string, number] | undefined;
	readonly post: number;
	readonly dev: number | undefined;
}

function parseVersion(input: string): ParsedVersion {
	let value = input.trim().toLowerCase().replace(/^v/, "");
	const epochMatch = value.match(/^([0-9]+)!/);
	const epoch = epochMatch ? Number(epochMatch[1]) : 0;
	if (epochMatch) value = value.slice(epochMatch[0].length);
	value = value.split("+")[0] ?? value;
	const devMatch = value.match(/(?:[.-]?dev)([0-9]*)$/);
	const dev = devMatch ? Number(devMatch[1] || 0) : undefined;
	if (devMatch) value = value.slice(0, devMatch.index);
	const postMatch = value.match(/(?:[.-]?(?:post|rev|r))([0-9]*)$/);
	const post = postMatch ? Number(postMatch[1] || 0) : 0;
	if (postMatch) value = value.slice(0, postMatch.index);
	const preMatch = value.match(/(?:[.-]?(a|b|rc|alpha|beta|preview|pre))([0-9]*)$/);
	const pre = preMatch
		? ([
				preMatch[1]!.replace("alpha", "a").replace("beta", "b").replace("preview", "rc").replace("pre", "rc"),
				Number(preMatch[2] || 0),
			] as const)
		: undefined;
	if (preMatch) value = value.slice(0, preMatch.index);
	const release = value
		.split(/[.-]/)
		.filter(Boolean)
		.map((part) => Number(part) || 0);
	return { epoch, release, pre, post, dev };
}

function compareVersions(leftInput: string, rightInput: string): number {
	const left = parseVersion(leftInput);
	const right = parseVersion(rightInput);
	if (left.epoch !== right.epoch) return left.epoch - right.epoch;
	const length = Math.max(left.release.length, right.release.length);
	for (let index = 0; index < length; index++) {
		const difference = (left.release[index] ?? 0) - (right.release[index] ?? 0);
		if (difference) return difference;
	}
	if (left.pre && !right.pre) return -1;
	if (!left.pre && right.pre) return 1;
	if (left.pre && right.pre) {
		const rank = { a: 0, b: 1, rc: 2 } as const;
		const preDifference =
			(rank[left.pre[0] as keyof typeof rank] ?? 2) - (rank[right.pre[0] as keyof typeof rank] ?? 2);
		if (preDifference) return preDifference;
		if (left.pre[1] !== right.pre[1]) return left.pre[1] - right.pre[1];
	}
	if (left.post !== right.post) return left.post - right.post;
	if (left.dev === undefined && right.dev !== undefined) return 1;
	if (left.dev !== undefined && right.dev === undefined) return -1;
	if (left.dev !== undefined && right.dev !== undefined) return left.dev - right.dev;
	return 0;
}

function versionSatisfies(version: string, specs: readonly VersionSpec[]): boolean {
	if (specs.length === 0) return true;
	const parsed = parseVersion(version);
	const normalized = `${parsed.epoch ? `${parsed.epoch}!` : ""}${parsed.release.join(".")}${parsed.pre ? `${parsed.pre[0]}${parsed.pre[1]}` : ""}${parsed.post ? `.post${parsed.post}` : ""}`;
	return specs.every((spec) => {
		const wildcard = spec.version.endsWith(".*");
		const expected = wildcard ? spec.version.slice(0, -2) : spec.version;
		const comparison = compareVersions(version, expected);
		const equals = (): boolean => {
			if (!wildcard) return comparison === 0;
			const release = parseVersion(expected).release.join(".");
			return normalized === release || normalized.startsWith(`${release}.`);
		};
		switch (spec.operator) {
			case "===":
				return version === expected;
			case "==":
				return equals();
			case "!=":
				return !equals();
			case "<":
				return comparison < 0;
			case "<=":
				return comparison <= 0;
			case ">":
				return comparison > 0;
			case ">=":
				return comparison >= 0;
			case "~=": {
				const expectedVersion = parseVersion(expected);
				const upperRelease =
					expectedVersion.release.length <= 1
						? [expectedVersion.release[0]! + 1]
						: [...expectedVersion.release.slice(0, -2), (expectedVersion.release.at(-2) ?? 0) + 1];
				const upper = upperRelease.join(".");
				return compareVersions(version, expected) >= 0 && compareVersions(version, upper) < 0;
			}
			default:
				return false;
		}
	});
}

function hasExplicitPrerelease(specs: readonly VersionSpec[]): boolean {
	return specs.some((spec) => /(?:a|b|rc|alpha|beta|dev|post)[0-9]*/i.test(spec.version));
}

function isSupportedPureWheel(filename: string): boolean {
	if (!filename.endsWith(".whl")) return false;
	const parts = filename.slice(0, -4).split("-");
	if (parts.length < 5) return false;
	const pythonTags = parts.at(-3)!.split(".");
	const abi = parts.at(-2);
	const platform = parts.at(-1);
	return abi === "none" && platform === "any" && pythonTags.some((tag) => tag === "py3" || tag === "py2.py3");
}

function artifactFromFiles(
	files: readonly PyPIFile[] | undefined,
	packageName: string,
	version: string,
): Artifact | undefined {
	const candidates = (files ?? []).filter((file) => !file.yanked);
	const pure = candidates.find((file) => file.packagetype === "bdist_wheel" && isSupportedPureWheel(file.filename));
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

async function fetchPypi(ctx: CommandContext, url: string, json: boolean): Promise<FetchResult> {
	const fetch = ctx.fetch;
	if (!fetch) fail("network access is required; create the sandbox with network:true");
	if (!isPypiUrl(url)) fail("refusing a PyPI URL outside pypi.org/files.pythonhosted.org");
	let current = url;
	for (let redirect = 0; redirect <= PIP_LIMITS.maxRedirects; redirect++) {
		const response = await fetch(current, { followRedirects: false, timeoutMs: 30_000 });
		if (response.status >= 300 && response.status < 400) {
			if (redirect === PIP_LIMITS.maxRedirects) fail("PyPI download exceeded the redirect limit");
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
		if (response.status < 200 || response.status >= 300) fail(`PyPI request failed with HTTP ${response.status}`);
		if (response.body.length > (json ? PIP_LIMITS.maxMetadataBytes : PIP_LIMITS.maxDownloadBytes)) {
			fail(json ? "PyPI metadata exceeds the response limit" : "wheel exceeds the download limit");
		}
		return response;
	}
	fail("PyPI redirect handling failed");
}

async function fetchJson(ctx: CommandContext, url: string, cache: Map<string, PyPIIndex>): Promise<PyPIIndex> {
	const cached = cache.get(url);
	if (cached) return cached;
	const response = await fetchPypi(ctx, url, true);
	let parsed: unknown;
	try {
		parsed = JSON.parse(utf8Decoder.decode(response.body));
	} catch {
		fail("PyPI returned invalid JSON");
	}
	if (!parsed || typeof parsed !== "object") fail("PyPI returned invalid JSON");
	const index = parsed as PyPIIndex;
	cache.set(url, index);
	return index;
}

async function selectPackage(
	ctx: CommandContext,
	requirement: Requirement,
	cache: Map<string, PyPIIndex>,
): Promise<ResolvedPackage> {
	const index = await fetchJson(ctx, `${PYPI_JSON_ORIGIN}/pypi/${encodeURIComponent(requirement.name)}/json`, cache);
	const allowPrerelease = hasExplicitPrerelease(requirement.specs);
	const releases = Object.keys(index.releases ?? {})
		.filter((version) => versionSatisfies(version, requirement.specs))
		.filter((version) => allowPrerelease || !parseVersion(version).pre)
		.sort((left, right) => compareVersions(right, left));
	if (releases.length === 0) fail(`no PyPI release satisfies '${requirement.raw}'`);
	let inspected = 0;
	for (const version of releases) {
		if (++inspected > PIP_LIMITS.maxCandidateVersions)
			fail(`too many candidate versions while resolving ${requirement.name}`);
		const artifact = artifactFromFiles(index.releases?.[version], requirement.name, version);
		if (!artifact) continue;
		const metadata =
			version === index.info?.version
				? index
				: await fetchJson(
						ctx,
						`${PYPI_JSON_ORIGIN}/pypi/${encodeURIComponent(requirement.name)}/${encodeURIComponent(version)}/json`,
						cache,
					);
		return { name: requirement.name, version, artifact, requiresDist: metadata.info?.requires_dist ?? [] };
	}
	fail(
		`${requirement.name} has no supported pure-Python py3-none-any wheel for the requested versions (sdists/native wheels are rejected)`,
	);
}

async function resolvePlan(ctx: CommandContext, roots: readonly Requirement[]): Promise<readonly ResolvedPackage[]> {
	const constraints = new Map<string, Requirement[]>();
	const depths = new Map<string, number>();
	const resolved = new Map<string, ResolvedPackage>();
	const indexCache = new Map<string, PyPIIndex>();
	const pending: string[] = [];
	for (const root of roots) {
		constraints.set(root.name, [...(constraints.get(root.name) ?? []), root]);
		depths.set(root.name, 0);
		pending.push(root.name);
	}
	let processed = 0;
	while (pending.length) {
		const name = pending.shift()!;
		if (++processed > PIP_LIMITS.maxDependencies * 4) fail("dependency resolution exceeded its work limit");
		const requirements = constraints.get(name) ?? [];
		const merged: Requirement = {
			name,
			specs: requirements.flatMap((requirement) => requirement.specs),
			raw: requirements.map((requirement) => requirement.raw).join(", "),
		};
		const candidate = await selectPackage(ctx, merged, indexCache);
		const depth = depths.get(name) ?? 0;
		const previous = resolved.get(name);
		if (previous?.version === candidate.version) continue;
		resolved.set(name, candidate);
		if (resolved.size > PIP_LIMITS.maxDependencies) fail(`dependency count exceeds ${PIP_LIMITS.maxDependencies}`);
		for (const rawDependency of candidate.requiresDist) {
			const dependency = parseRequirement(rawDependency);
			if (!dependency) continue;
			const dependencyDepth = depth + 1;
			if (dependencyDepth > PIP_LIMITS.maxDependencyDepth)
				fail(`dependency depth exceeds ${PIP_LIMITS.maxDependencyDepth} at ${dependency.name}`);
			const list = constraints.get(dependency.name) ?? [];
			list.push(dependency);
			constraints.set(dependency.name, list);
			depths.set(dependency.name, Math.max(depths.get(dependency.name) ?? 0, dependencyDepth));
			pending.push(dependency.name);
		}
	}
	return [...resolved.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function runWasmPython(ctx: CommandContext, code: string, args: readonly string[]): Promise<ExecResult> {
	if (!ctx.exec) fail("the just-bash execution context cannot run the WASM Python helper");
	return ctx.exec("python", {
		cwd: ctx.cwd,
		args: ["-c", code, ...args],
		stdin: "",
		signal: ctx.signal,
		env: inheritedEnvironment(ctx),
	});
}

async function existingPackageTotals(ctx: CommandContext): Promise<{ files: number; bytes: number }> {
	const paths = ctx.fs.getAllPaths().filter((path) => path.startsWith(`${SITE_PACKAGES}/`));
	const stats = await Promise.all(paths.map((path) => ctx.fs.lstat(path)));
	let files = 0;
	let bytes = 0;
	for (const stat of stats) {
		if (!stat.isFile) continue;
		files++;
		bytes += stat.size;
	}
	return { files, bytes };
}

/** The WASM helper prints one JSON object on both paths; tracebacks are not an API contract. */
function parseHelperJson(stdout: string): Record<string, unknown> | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	try {
		const value: unknown = JSON.parse(trimmed);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

async function writeRequestsCompat(ctx: CommandContext): Promise<void> {
	for (const [relativePath, content] of Object.entries(REQUESTS_COMPAT_FILES)) {
		const slash = relativePath.lastIndexOf("/");
		const directory = slash < 0 ? COMPAT_PACKAGES : `${COMPAT_PACKAGES}/${relativePath.slice(0, slash)}`;
		await ctx.fs.mkdir(directory, { recursive: true });
		await ctx.fs.writeFile(`${COMPAT_PACKAGES}/${relativePath}`, content);
	}
}

async function verifyAndExtract(
	ctx: CommandContext,
	packageInfo: ResolvedPackage,
	body: Uint8Array,
	totals: { downloads: number; files: number; bytes: number },
): Promise<void> {
	if (body.length > PIP_LIMITS.maxDownloadBytes) fail(`wheel ${packageInfo.name} exceeds the download limit`);
	if (totals.downloads + body.length > PIP_LIMITS.maxTotalDownloadBytes)
		fail("total package downloads exceed the limit");
	totals.downloads += body.length;
	// The bytes are already in host memory, so verify before anything is written
	// rather than paying a CPython worker boot to re-read them off the sandbox FS.
	if (createHash("sha256").update(body).digest("hex") !== packageInfo.artifact.sha256)
		fail(`SHA-256 verification failed for ${packageInfo.name} ${packageInfo.version}`);
	await ctx.fs.mkdir(TEMP_ROOT, { recursive: true });
	const safeFilename = packageInfo.artifact.filename.replace(/[^A-Za-z0-9._-]/g, "_");
	const wheelPath = `${TEMP_ROOT}/${safeFilename}`;
	await ctx.fs.writeFile(wheelPath, body);
	try {
		const extraction = await runWasmPython(ctx, EXTRACT_CODE, [
			wheelPath,
			SITE_PACKAGES,
			String(PIP_LIMITS.maxWheelFiles - totals.files),
			String(PIP_LIMITS.maxExtractedBytes - totals.bytes),
		]);
		const report = parseHelperJson(extraction.stdout);
		if (extraction.exitCode !== 0) fail(typeof report?.error === "string" ? report.error : "wheel extraction failed");
		const { files, bytes } = report ?? {};
		if (typeof files !== "number" || typeof bytes !== "number") fail("wheel extraction returned invalid limits");
		totals.files += files;
		totals.bytes += bytes;
		if (totals.files > PIP_LIMITS.maxWheelFiles || totals.bytes > PIP_LIMITS.maxExtractedBytes)
			fail("installed package contents exceed the limit");
	} finally {
		await ctx.fs.rm(wheelPath, { force: true });
	}
}

async function install(ctx: CommandContext, specs: readonly string[]): Promise<ExecResult> {
	if (!ctx.fetch) return commandFailure("pip: network access is required; create the sandbox with network:true", 1);
	if (specs.length === 0) return commandFailure("pip: install requires at least one package", 2);
	try {
		const roots = specs.map(parseRequirement).filter((value): value is Requirement => value !== undefined);
		if (roots.length !== specs.length)
			return commandFailure("pip: package markers are not supported for direct installs", 1);
		if (await ctx.fs.exists(SITE_PACKAGES)) {
			const rootStat = await ctx.fs.lstat(SITE_PACKAGES);
			if (!rootStat.isDirectory || rootStat.isSymbolicLink) fail("package directory is not a real directory");
		}
		const packages = await resolvePlan(ctx, roots);
		const installed = await existingPackageTotals(ctx);
		if (installed.files > PIP_LIMITS.maxWheelFiles || installed.bytes > PIP_LIMITS.maxExtractedBytes)
			fail("existing package contents exceed the limit");
		const totals = { downloads: 0, files: installed.files, bytes: installed.bytes };
		for (const packageInfo of packages) {
			const response = await fetchPypi(ctx, packageInfo.artifact.url, false);
			await verifyAndExtract(ctx, packageInfo, response.body, totals);
		}
		if (packages.some((packageInfo) => packageInfo.name === "requests")) await writeRequestsCompat(ctx);
		return {
			stdout: `Successfully installed ${packages.map((item) => `${item.name}-${item.version}`).join(" ")}\n`,
			stderr: "",
			exitCode: 0,
		};
	} catch (error) {
		return commandFailure(`pip: ${error instanceof PipError ? error.message : "package installation failed"}`, 1);
	}
}

async function executePip(args: string[], ctx: CommandContext): Promise<ExecResult> {
	if (args[0] === "--version" || args[0] === "-V")
		return { stdout: "sql-fs experimental pip (pure-Python wheels only)\n", stderr: "", exitCode: 0 };
	if (args[0] !== "install")
		return commandFailure("pip: only 'pip install PACKAGE' is supported by this experiment", 2);
	const packages = args.slice(1);
	if (packages.some((item) => item.startsWith("-")))
		return commandFailure("pip: install options are not supported; use package specifiers only", 2);
	return install(ctx, packages);
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

function redactDatabricksResult(result: ExecResult, ctx: CommandContext): ExecResult {
	const secrets = DATABRICKS_SECRET_KEYS.map((key) => ctx.env.get(key)).filter(
		(value): value is string => typeof value === "string" && value.length > 0,
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

/** `ctx.exec` is just-bash's documented delegation path to the built-in WASM python. */
function invokeBuiltinPython(ctx: CommandContext, args: readonly string[], stdin: string): Promise<ExecResult> {
	if (!ctx.exec) return Promise.resolve(commandFailure("python3: WASM Python command is unavailable"));
	return ctx.exec("python", { cwd: ctx.cwd, args: [...args], stdin, env: inheritedEnvironment(ctx) });
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

/** Rewrites a python3 invocation so installed packages are importable. */
function packagePythonArgs(args: string[]): string[] | undefined {
	const codeIndex = args.indexOf("-c");
	if (codeIndex >= 0) {
		const source = args[codeIndex + 1];
		if (source === undefined) return undefined;
		return ["-c", `${PYTHON_PACKAGE_BOOTSTRAP}\n${source}`, ...args.slice(codeIndex + 2)];
	}
	const moduleIndex = args.indexOf("-m");
	if (moduleIndex >= 0) {
		const module = args[moduleIndex + 1];
		if (module === undefined) return undefined;
		return runpyProgram([module, ...args.slice(moduleIndex + 2)], "run_module", module);
	}
	const scriptIndex = args.findIndex((arg) => !arg.startsWith("-") || arg === "-");
	if (scriptIndex < 0) return args;
	const script = args[scriptIndex]!;
	const argv = [script, ...args.slice(scriptIndex + 1)];
	if (script === "-") return bootstrapProgram(argv, 'exec(compile(_sqlfs_sys.stdin.read(), "<stdin>", "exec"))');
	return runpyProgram(argv, "run_path", script);
}

const pipCommand = defineCommand("pip", executePip);
const pip3Command = defineCommand("pip3", executePip);

const python3PackageCommand = defineCommand("python3", async (args, ctx): Promise<ExecResult> => {
	const stdin = decodeBytesToUtf8(ctx.stdin);
	if (args.includes("--version") || args.includes("-V") || args.includes("--help")) {
		return invokeBuiltinPython(ctx, args, stdin);
	}
	return invokeBuiltinPython(ctx, packagePythonArgs(args) ?? args, stdin);
});

const databricksCommand = defineCommand("databricks", async (args, ctx): Promise<ExecResult> => {
	if (!ctx.fetch) return commandFailure("databricks: network access is disabled; create the sandbox with network:true");
	if (!ctx.exec) return commandFailure("databricks: WASM Python command is unavailable");
	const entrypoint = await getDatabricksEntrypoint(ctx);
	if (!entrypoint) return commandFailure("databricks: install databricks-cli first with 'pip install databricks-cli'");
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
	const result = await invokeBuiltinPython(ctx, program, decodeBytesToUtf8(ctx.stdin));
	return redactDatabricksResult(result, ctx);
});

export const pythonPackageCommands = [pipCommand, pip3Command, python3PackageCommand, databricksCommand];
