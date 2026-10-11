// TASK-001 scripts/link-checkout.mjs
//
// Point this probe's node_modules at the local pi checkout instead of the npm
// registry. The task forbids substituting a same-named registry package for the
// current checkout, so every @earendil-works/* name the probe can reach is a
// symlink into that checkout.
//
// Why not `file:` dependencies in package.json: npm rewrites those into copies
// and re-resolves the checkout package's own nested deps against the registry,
// which is exactly what we must avoid.
//
// Why the links are top-level only: creating node_modules/ symlinks *inside* the
// checkout packages makes npm's arborist recurse forever on the next install
// (`#loadPeerSet` -> Cannot read properties of null (reading 'edgesOut')). So
// this script runs *after* `npm install` and never writes inside the checkout.
// Nested imports from pi-durable resolve because Node walks up from the symlink's
// real path into the checkout's own root node_modules, which the checkout's
// install already populated.

import { mkdir, rm, symlink, stat, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const probeRoot = resolve(here, "..");

/** The checkout root, overridable for a different local clone. */
const checkout = resolve(process.env.PI_CHECKOUT ?? join(probeRoot, "..", "base-durable-vaction-agent", "pi"));

const packages = [
	{ dir: "packages/chord", name: "@earendil-works/chord" },
	{ dir: "packages/ai", name: "@earendil-works/pi-ai" },
	{ dir: "packages/durable", name: "@earendil-works/pi-durable" },
];

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Symlink `target` at `link`, replacing whatever is there. */
async function link(target, linkPath) {
	await mkdir(dirname(linkPath), { recursive: true });
	try {
		const current = await lstat(linkPath);
		await rm(linkPath, { recursive: current.isDirectory() && !current.isSymbolicLink(), force: true });
	} catch {
		// Nothing to replace.
	}
	await symlink(target, linkPath, "junction");
}

async function main() {
	if (!(await exists(join(checkout, "packages", "durable", "package.json")))) {
		throw new Error(`No pi checkout at ${checkout}; set PI_CHECKOUT or clone the repo there.`);
	}
	const rootModules = join(probeRoot, "node_modules");
	for (const { dir, name } of packages) {
		const packageDir = join(checkout, dir);
		if (!(await exists(packageDir))) throw new Error(`Missing ${packageDir}`);
		await link(packageDir, join(rootModules, name));
	}
	console.log(`[link] checkout: ${checkout}`);
	for (const { dir, name } of packages) console.log(`[link] ${name} -> ${join(checkout, dir)}`);
}

await main();
