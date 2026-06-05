export const defaultMaxFileSize = 64 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
	try {
		const value = (await response.json()) as unknown;
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}
