import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils/dirs";

export const KOKORO_PACKAGE = "kokoro-js";
export const KOKORO_VERSION = "1.2.1";
export const ONNXRUNTIME_NODE_PACKAGE = "onnxruntime-node";
export const ONNXRUNTIME_NODE_VERSION = "1.26.0";
export const ONNXRUNTIME_NODE_ANDROID_STUB = "npm:onnxruntime-common@1.26.0";
export const SHARP_ANDROID_STUB = "npm:is-even@1.0.0";

export interface TtsRuntimePlan {
	transformersSpecifier: string;
	overrides: Record<string, string>;
	trustedDependencies: string[] | undefined;
}

export function ttsRuntimePlan(platform: NodeJS.Platform | string = process.platform): TtsRuntimePlan {
	const android = platform === "android";
	return {
		transformersSpecifier: android
			? "@huggingface/transformers/dist/transformers.web.js"
			: "@huggingface/transformers",
		overrides: android
			? {
					[ONNXRUNTIME_NODE_PACKAGE]: ONNXRUNTIME_NODE_ANDROID_STUB,
					sharp: SHARP_ANDROID_STUB,
				}
			: { [ONNXRUNTIME_NODE_PACKAGE]: ONNXRUNTIME_NODE_VERSION },
		trustedDependencies: android ? undefined : [ONNXRUNTIME_NODE_PACKAGE],
	};
}

export function getTtsRuntimeDir(): string {
	const runtimeKey = KOKORO_VERSION.replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(path.dirname(getTinyModelsCacheDir()), "tts-runtime", `kokoro-${runtimeKey}`);
}

export async function isTtsRuntimeCached(): Promise<boolean> {
	try {
		const pkg = await Bun.file(path.join(getTtsRuntimeDir(), "node_modules", KOKORO_PACKAGE, "package.json")).json();
		return typeof pkg === "object" && pkg !== null && "version" in pkg && pkg.version === KOKORO_VERSION;
	} catch {
		return false;
	}
}
