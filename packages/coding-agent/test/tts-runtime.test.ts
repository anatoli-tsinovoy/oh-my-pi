import { describe, expect, it } from "bun:test";
import {
	ONNXRUNTIME_NODE_ANDROID_STUB,
	ONNXRUNTIME_NODE_PACKAGE,
	ONNXRUNTIME_NODE_VERSION,
	SHARP_ANDROID_STUB,
	ttsRuntimePlan,
} from "../src/tts/runtime";
import { withAndroidWebRuntime } from "../src/subprocess/worker-runtime";

const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

describe("TTS runtime selection", () => {
	it("uses the Transformers web bundle and stubs native-only dependencies on Android", () => {
		expect(ttsRuntimePlan("android")).toEqual({
			transformersSpecifier: `${TRANSFORMERS_PACKAGE}/dist/transformers.web.js`,
			overrides: {
				[ONNXRUNTIME_NODE_PACKAGE]: ONNXRUNTIME_NODE_ANDROID_STUB,
				sharp: SHARP_ANDROID_STUB,
			},
			trustedDependencies: undefined,
		});
	});

	it("preserves the native ONNX Runtime plan on desktop", () => {
		expect(ttsRuntimePlan("linux")).toEqual({
			transformersSpecifier: TRANSFORMERS_PACKAGE,
			overrides: { [ONNXRUNTIME_NODE_PACKAGE]: ONNXRUNTIME_NODE_VERSION },
			trustedDependencies: [ONNXRUNTIME_NODE_PACKAGE],
		});
	});

	it("scopes Bun's web-runtime identity override to module evaluation", () => {
		const original = process.release.name;
		const observed = withAndroidWebRuntime(() => process.release.name);

		expect(observed).toBe("bun");
		expect(process.release.name).toBe(original);
	});
});
