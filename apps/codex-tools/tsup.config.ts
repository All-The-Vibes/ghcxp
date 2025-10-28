import type { Plugin } from "esbuild";
import { defineConfig, type Options } from "tsup";

const esbuildProblemMatcherPlugin: Plugin = {
	name: "esbuild-problem-matcher",
	setup: (build) => {
		build.onStart(() => {
			console.log("[watch] build started");
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location === null) return;
				console.error(
					`    ${location.file}:${location.line}:${location.column}:`,
				);
			});
			console.log("[watch] build finished");
		});
	},
};

export default defineConfig((options: Options) => {
	const isWatch = !!options.watch;

	const baseConfig: Options = {
		target: "node20",
		outDir: "dist",
		format: ["cjs"],
		external: ["vscode"],
		esbuildPlugins: [],
		define: {
			navigator: "undefined",
		},
		clean: true,
	};

	if (isWatch) {
		return {
			...baseConfig,
			entry: ["src/**/*.ts"],
			minify: false,
			sourcemap: true,
			bundle: false,
			treeshake: false,
			esbuildPlugins: [esbuildProblemMatcherPlugin],
			...options,
		} satisfies Options;
	}

	return {
		...baseConfig,
		entry: ["src/extension.ts"],
		minify: true,
		sourcemap: false,
		noExternal: ["tsup", "vscode-uri", "zod"],
		treeshake: true,
		...options,
	} satisfies Options;
});
