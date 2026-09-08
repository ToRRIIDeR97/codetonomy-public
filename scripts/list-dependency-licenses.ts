import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface PackageManifest {
	name?: string;
	version?: string;
	license?: string | { type?: string };
}

interface DependencyRecord {
	license: string;
	path?: string;
}

const manifests = new Map<string, DependencyRecord>();
const pythonLicenses: Record<string, string> = {
	"mlx-vlm": "MIT",
	"openpyxl": "MIT",
	"pillow": "HPND",
	"pypdfium2": "Apache-2.0 OR BSD-3-Clause (plus bundled PDFium dependency licenses)",
	"python-pptx": "MIT",
};

async function recordPackage(path: string): Promise<void> {
	try {
		const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as PackageManifest;
		if (!manifest.name || !manifest.version) return;
		if (manifest.name === "fsevents" || manifest.name.startsWith("@esbuild/") || /^@mariozechner\/clipboard-(?:darwin|linux|win32)-/.test(manifest.name)) return;
		const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
		manifests.set(`${manifest.name}@${manifest.version}`, { license: license ?? "UNKNOWN", path });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

for (const entry of await readdir(resolve("node_modules/.pnpm"), { withFileTypes: true })) {
	if (!entry.isDirectory() || entry.name === "node_modules") continue;
	const modules = join(resolve("node_modules/.pnpm"), entry.name, "node_modules");
	let dependencies;
	try {
		dependencies = await readdir(modules, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
		throw error;
	}
	for (const dependency of dependencies) {
		if (dependency.name.startsWith("@")) {
			for (const scoped of await readdir(join(modules, dependency.name), { withFileTypes: true })) {
				if (scoped.isDirectory() || scoped.isSymbolicLink()) await recordPackage(join(modules, dependency.name, scoped.name));
			}
		} else if (dependency.isDirectory() || dependency.isSymbolicLink()) await recordPackage(join(modules, dependency.name));
	}
}

for (const service of await readdir(resolve("services"), { withFileTypes: true })) {
	if (!service.isDirectory()) continue;
	const servicePath = join(resolve("services"), service.name);
	const files = (await readdir(servicePath, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && /^requirements.*\.txt$/.test(entry.name))
		.map(({ name }) => name)
		.sort();
	for (const file of files) {
		const requirements = await readFile(join(servicePath, file), "utf8");
		for (const raw of requirements.split(/\r?\n/)) {
			const line = raw.replace(/\s+#.*$/, "").trim();
			if (!line || line.startsWith("#")) continue;
			const match = line.match(/^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$/);
			if (!match) throw new Error(`${service.name}/${file} has an unpinned or unsupported Python requirement: ${line}`);
			const name = match[1]!.toLowerCase();
			const license = pythonLicenses[name];
			if (!license) throw new Error(`Unknown Python dependency license: ${name}@${match[2]}`);
			manifests.set(`${name}@${match[2]} (Python)`, { license });
		}
	}
}

const byLicense = new Map<string, string[]>();
for (const [name, { license }] of [...manifests].sort(([a], [b]) => a.localeCompare(b))) {
	byLicense.set(license, [...(byLicense.get(license) ?? []), name]);
}
for (const [license, packages] of [...byLicense].sort(([a], [b]) => a.localeCompare(b))) {
	console.log(`${license}: ${packages.length}`);
}
const unknown = byLicense.get("UNKNOWN") ?? [];
if (unknown.length) throw new Error(`Dependencies with unknown licenses: ${unknown.join(", ")}`);

const licenseTexts = new Map<string, { text: string; packages: Set<string>; files: Set<string>; licenses: Set<string> }>();
const missingLicenseFiles: Array<{ name: string; license: string }> = [];
for (const [name, record] of [...manifests].sort(([left], [right]) => left.localeCompare(right))) {
	if (!record.path) continue;
	const entries = await readdir(record.path, { withFileTypes: true });
	const files = entries.filter((entry) => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)).map(({ name: file }) => file).sort();
	if (!files.length) { missingLicenseFiles.push({ name, license: record.license }); continue; }
	for (const file of files) {
		const text = (await readFile(join(record.path, file), "utf8")).replaceAll("\r\n", "\n").trimEnd();
		if (Buffer.byteLength(text) > 512 * 1024) throw new Error(`${name}/${file} license text exceeds 512 KiB`);
		const hash = createHash("sha256").update(text).digest("hex");
		const group = licenseTexts.get(hash) ?? { text, packages: new Set<string>(), files: new Set<string>(), licenses: new Set<string>() };
		group.packages.add(name);
		group.files.add(file);
		group.licenses.add(record.license);
		licenseTexts.set(hash, group);
	}
}
for (const missing of missingLicenseFiles) {
	if (![...licenseTexts.values()].some(({ licenses }) => licenses.has(missing.license))) throw new Error(`${missing.name} has no license file and no bundled ${missing.license} license text`);
}

const inventory = [...manifests].sort(([left], [right]) => left.localeCompare(right)).map(([name, { license }]) => `- ${name} — ${license}`);
const sections = [...licenseTexts].sort(([left], [right]) => left.localeCompare(right)).map(([hash, group]) => {
	const fence = group.text.includes("```") ? "~~~~" : "```";
	return [
		`## License text ${hash.slice(0, 12)}`,
		"",
		`Packages: ${[...group.packages].sort().join(", ")}`,
		`Files: ${[...group.files].sort().join(", ")}`,
		"",
		`${fence}text`,
		group.text,
		fence,
	].join("\n");
});
const generated = [
	"# Bundled dependency licenses",
	"",
	"Generated from the portable JavaScript dependency tree used to build the self-contained Codetonomy artifact. Platform-specific optional packages carry their license files in their own installed packages. Python entries describe separately installed worker prerequisites; their wheels are not bundled.",
	"",
	"## Package inventory",
	"",
	...inventory,
	"",
	...sections.flatMap((section) => [section, ""]),
].join("\n");
const outputPath = resolve("THIRD_PARTY_LICENSES.md");
if (process.argv.includes("--write")) {
	await writeFile(outputPath, generated, "utf8");
	console.log(`Wrote ${outputPath}`);
} else {
	let current: string;
	try { current = await readFile(outputPath, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("THIRD_PARTY_LICENSES.md is missing; run npm run license:bundle");
		throw error;
	}
	if (current !== generated) throw new Error("THIRD_PARTY_LICENSES.md is stale; run npm run license:bundle");
}
