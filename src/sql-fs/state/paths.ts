import { createEinval, createEnotdir, createEperm } from "../errors.js";
export const DEV_NULL = "/dev/null";
export function normalizeFsPath(p: string): string {
	if (!p || p === "/") return "/";
	const s = p.startsWith("/") ? p : `/${p}`;
	const parts = s.split("/").filter((seg) => seg && seg !== ".");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return `/${stack.join("/")}`;
}

export function validatePath(p: string): string {
	if (p.includes("\0")) {
		throw createEinval(p);
	}
	const path = normalizeFsPath(p);
	if (path.startsWith(`${DEV_NULL}/`)) throw createEnotdir(DEV_NULL);
	return path;
}
export function parentOf(path: string): string {
	const idx = path.lastIndexOf("/");
	if (idx === 0) return "/";
	return path.slice(0, idx);
}
export function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
export function resolvePath(base: string, path: string): string {
	if (path.startsWith("/")) return normalizeFsPath(path);
	const combined = base === "/" ? `/${path}` : `${base}/${path}`;
	return normalizeFsPath(combined);
}
export function assertStoredPath(path: string, operation: string): void {
	if (path === DEV_NULL) throw createEperm(path, operation);
}
