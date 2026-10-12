export function retainedInputBytes(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8");
	if (value instanceof Uint8Array) return value.byteLength;
	if (Array.isArray(value)) return value.reduce((bytes, entry) => bytes + retainedInputBytes(entry), 0);
	if (value !== null && typeof value === "object") {
		let bytes = 0;
		for (const [key, entry] of Object.entries(value)) {
			bytes += Buffer.byteLength(key, "utf8") + retainedInputBytes(entry);
		}
		return bytes;
	}
	return typeof value === "number" ? 8 : typeof value === "boolean" ? 1 : 0;
}
