import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

await rm(resolve("dist"), { recursive: true, force: true });
await mkdir(resolve("dist"), { recursive: true });
await build({
	entryPoints: [resolve("apps/cli/src/index.ts")],
	outdir: resolve("dist"),
	entryNames: "Codetonomy",
	chunkNames: "chunks/[name]-[hash]",
	bundle: true,
	splitting: true,
	platform: "node",
	format: "esm",
	target: "node22",
	banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
	sourcemap: false,
	legalComments: "eof",
	logLevel: "info",
});
await chmod(resolve("dist/Codetonomy.js"), 0o755);
