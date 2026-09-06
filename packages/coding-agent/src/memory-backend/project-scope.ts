import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

/** Resolve memory identity without changing the session's working directory. */
export function resolveMemoryProjectRoot(cwd: string, shareAcrossWorktrees: boolean): string {
	const directory = path.resolve(cwd || ".");
	return shareAcrossWorktrees ? (vcs.repo(directory)?.primaryRoot() ?? directory) : directory;
}
