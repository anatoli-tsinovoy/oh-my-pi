import path from "node:path";
import { FileSessionStorage } from "../session/session-storage";
import { findResumableSessions } from "../session/session-listing";
import { readSessionHeaderId } from "../session/session-loader";

export const SEANCE_READ_TOOL_NAMES = ["read", "grep", "glob"] as const;
export const SEANCE_ACTIVE_TOOL_NAMES = [...SEANCE_READ_TOOL_NAMES, "yield"] as const;
/** Resolve and validate a seance source without opening it as a writable session. */
export async function resolveSeanceSession(source: string, cwd: string, sessionDir?: string): Promise<string> {
	const selector = source.trim();
	if (!selector) {
		throw new Error("A seance requires a source session ID or JSONL path.");
	}

	const storage = new FileSessionStorage();
	let filePath: string;
	if (selector.includes("/") || selector.includes("\\") || selector.toLowerCase().endsWith(".jsonl")) {
		filePath = path.resolve(cwd, selector);
	} else {
		const matches = await findResumableSessions(selector, cwd, sessionDir, storage, { allowGlobalFallback: true });
		if (matches.length === 0) {
			throw new Error(`Source session "${selector}" was not found.`);
		}
		if (matches.length > 1) {
			const paths = matches.map(match => path.basename(match.session.path)).join(", ");
			throw new Error(
				`Source session "${selector}" is ambiguous; use a longer ID prefix or a JSONL path (${paths}).`,
			);
		}
		filePath = matches[0].session.path;
	}

	let headerId: string | undefined;
	try {
		headerId = await readSessionHeaderId(filePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read seance source session "${filePath}": ${message}`, { cause: error });
	}
	if (headerId === undefined) {
		try {
			storage.statSync(filePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not read seance source session "${filePath}": ${message}`, { cause: error });
		}
		throw new Error(`Seance source "${filePath}" does not start with a valid session header.`);
	}
	if (headerId.trim().length === 0) {
		throw new Error(`Seance source "${filePath}" does not start with a valid session header.`);
	}
	return path.resolve(filePath);
}
