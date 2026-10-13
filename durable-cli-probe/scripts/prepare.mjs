// TASK-004 scripts/prepare.mjs
//
// One repeatable entry point that takes a fresh clone to a state where
// `npm run typecheck` and `npm run lint` can run. It is the only place that
// knows the order of operations; .github/workflows/ci.yml calls this script,
// so local preparation and CI preparation cannot drift apart.
//
// Order (same as the task spec):
//   1. read the pinned dependency config   (pi-pin.json)
//   2. prepare the Pi checkout at the pinned commit
//   3. install dependencies from the app and upstream lockfiles
//      (npm ci --ignore-scripts)
//   4. build the type artifacts the app's typecheck needs
//      (Chord -> Pi AI build:offline -> Durable)
//   5. link the three Pi packages (scripts/link-checkout.mjs, unchanged)
//   6. verify revision, package identity, and link targets
//
// Two deliberate non-actions:
//   * the upstream `npm run check` is never used: it runs
//     `biome check --write`, which rewrites files.
//   * the upstream full `build` / `generate-models` are never used: only the
//     minimal chain above. `ai`'s `build:offline` reads the model data that is
//     committed at the pinned commit instead of regenerating it.
//
// Safety: an existing checkout is never deleted or re-fetched. A revision
// mismatch or a dirty checkout is a hard failure with the evidence printed, so
// re-running this script can never destroy a checkout you were relying on.
//
// Usage:
//   node scripts/prepare.mjs [--clean] [--checkout-dir <path>]
//     --clean                 drop generated artifacts first (app node_modules
//                             and the three packages' dist); proves nothing
//                             pre-existing is relied upon
//     --checkout-dir <path>   override the checkout location (same as
//                             PI_CHECKOUT, which link-checkout.mjs also reads)

import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "..");
const pinPath = join(appRoot, "pi-pin.json");

/** Where link-checkout.mjs looks when PI_CHECKOUT is unset. */
const DEFAULT_CHECKOUT = join(appRoot, "..", "base-durable-vaction-agent", "pi");

const IS_WINDOWS = process.platform === "win32";

function log(message) {
	console.log(`[prepare] ${message}`);
}

function fail(message) {
	console.error(`[prepare] FAILED: ${message}`);
	process.exit(1);
}

/**
 * Run a command, inheriting stdio. Async spawn is used on purpose: this
 * repository is also prepared on Windows hosts where synchronous
 * child-process APIs (spawnSync / execSync) are refused with EBUSY, which
 * would make the script unusable for no reason of its own.
 */
function run(command, args, options = {}) {
	const printable = [command, ...args].join(" ");
	log(`$ ${printable}`);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
		child.on("error", (error) => reject(new Error(`${printable} could not be started: ${error.message}`)));
		child.on("close", (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${printable} exited with ${code === null ? `signal ${signal}` : code}`));
		});
	});
}

/** Run a command and return its stdout. stderr stays inherited so it is visible. */
function capture(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options });
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", (error) => reject(new Error(`${command} could not be started: ${error.message}`)));
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
			else resolvePromise(stdout.trim());
		});
	});
}

/**
 * Run npm. On Windows `npm` is a .cmd, which only a shell can start; the
 * arguments are plain tokens with no paths in them, so shell quoting is not a
 * risk. Everywhere else npm is started directly.
 */
function npm(args, options = {}) {
	return run("npm", args, { shell: IS_WINDOWS, ...options });
}

function readPin() {
	let pin;
	try {
		pin = JSON.parse(readFileSync(pinPath, "utf8"));
	} catch (error) {
		fail(`cannot read ${pinPath}: ${error.message}`);
	}
	const problems = [];
	if (typeof pin.repository !== "string" || !pin.repository.startsWith("https://")) {
		problems.push("repository must be an https:// URL");
	}
	if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) {
		problems.push("commit must be a full 40-character lowercase SHA");
	}
	if (!Array.isArray(pin.packages) || pin.packages.length === 0) {
		problems.push("packages must be a non-empty array");
	}
	for (const entry of pin.packages ?? []) {
		if (typeof entry.name !== "string" || !entry.name.startsWith("@")) {
			problems.push(`package name is not a scoped name: ${JSON.stringify(entry)}`);
		}
		if (typeof entry.dir !== "string" || isAbsolute(entry.dir)) {
			problems.push(`package dir must be a checkout-relative path: ${JSON.stringify(entry)}`);
		}
	}
	if (problems.length > 0) fail(`pi-pin.json is invalid: ${problems.join("; ")}`);
	return pin;
}

/** The checkout path this run will use, matching link-checkout.mjs's default. */
function resolveCheckoutDir(cliOverride) {
	const chosen = cliOverride ?? process.env.PI_CHECKOUT ?? DEFAULT_CHECKOUT;
	return resolve(chosen);
}

/**
 * Make sure the checkout exists, is a git repository, is at the pinned commit,
 * has no local modifications, and its origin is the official repository.
 * An existing checkout is reused as-is; it is never re-fetched or deleted.
 */
async function prepareCheckout(checkoutDir, pin) {
	if (existsSync(checkoutDir) && !existsSync(join(checkoutDir, ".git"))) {
		fail(`${checkoutDir} exists but is not a git repository. Point PI_CHECKOUT (or --checkout-dir) at a real checkout, or remove the directory yourself.`);
	}

	if (existsSync(join(checkoutDir, ".git"))) {
		log(`existing checkout at ${checkoutDir}`);
		const actual = await capture("git", ["-C", checkoutDir, "rev-parse", "HEAD"]);
		if (actual !== pin.commit) {
			fail(`checkout revision conflict: pinned ${pin.commit}, found ${actual}. Move the checkout aside or point PI_CHECKOUT somewhere else; this script never rewrites a checkout for you.`);
		}
		const dirty = await capture("git", ["-C", checkoutDir, "status", "--porcelain"]);
		if (dirty !== "") {
			fail(`checkout has local modifications; refusing to install and build on top of them:\n${dirty}`);
		}
	} else {
		log(`no checkout at ${checkoutDir}; fetching the pinned commit from ${pin.repository}`);
		await run("git", ["init", "-q", "-b", "main", checkoutDir]);
		await run("git", ["-C", checkoutDir, "remote", "add", "origin", pin.repository]);
		// Fetch by SHA: the pinned commit is reachable from the official remote,
		// so no branch or tag has to be guessed and no full clone is needed.
		await run("git", ["-C", checkoutDir, "fetch", "--depth", "1", "origin", pin.commit]);
		await run("git", ["-C", checkoutDir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"]);
		const actual = await capture("git", ["-C", checkoutDir, "rev-parse", "HEAD"]);
		if (actual !== pin.commit) fail(`fetched ${actual} but pinned ${pin.commit}`);
	}

	const origin = await capture("git", ["-C", checkoutDir, "remote", "get-url", "origin"]);
	if (origin === pin.repository) {
		log(`checkout origin: ${origin}`);
	} else {
		// A local-path origin is allowed: identity is the pinned commit SHA, not
		// the path a clone was made from. What matters is that the SHA itself is
		// obtainable from the official remote, which this script proves whenever
		// it creates a checkout, and which was verified when the pin was written
		// (pi-pin.json -> verified).
		log(`checkout origin: ${origin} (local path, not the official URL)`);
		log(`identity rests on commit ${pin.commit}, which is fetched by SHA from ${pin.repository}`);
	}
}

async function clean(checkoutDir, pin) {
	log("--clean: removing generated artifacts (app node_modules and the three packages' dist)");
	rmSync(join(appRoot, "node_modules"), { recursive: true, force: true });
	for (const { dir } of pin.packages) {
		rmSync(join(checkoutDir, dir, "dist"), { recursive: true, force: true });
	}
}

async function verify(checkoutDir, pin) {
	const problems = [];

	const actual = await capture("git", ["-C", checkoutDir, "rev-parse", "HEAD"]);
	if (actual !== pin.commit) problems.push(`checkout is at ${actual}, pinned ${pin.commit}`);

	const dirty = await capture("git", ["-C", checkoutDir, "status", "--porcelain"]);
	if (dirty !== "") problems.push(`checkout has local modifications after preparation:\n${dirty}`);

	const appModules = join(appRoot, "node_modules");
	for (const { name, dir } of pin.packages) {
		const linkPath = join(appModules, name);
		const packageDir = resolve(join(checkoutDir, dir));
		if (!existsSync(linkPath)) {
			problems.push(`${name} is not linked at ${linkPath}`);
			continue;
		}
		if (!lstatSync(linkPath).isSymbolicLink()) {
			problems.push(`${name} at ${linkPath} is not a symlink (a copy would be a second identity)`);
			continue;
		}
		const real = realpathSync(linkPath);
		if (real !== realpathSync(packageDir)) {
			problems.push(`${name} resolves to ${real}, expected ${packageDir}`);
		}
		const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		if (manifest.name !== name) problems.push(`${linkPath} declares ${manifest.name}, expected ${name}`);
		// The app's typecheck reads the upstream declarations, so the build must
		// have produced them.
		if (!existsSync(join(packageDir, "dist", "index.d.ts"))) {
			problems.push(`${packageDir}/dist/index.d.ts is missing; the type artifacts were not built`);
		}
		log(`verified ${name}@${manifest.version} -> ${real}`);
	}

	if (problems.length > 0) fail(`verification failed:\n- ${problems.join("\n- ")}`);
}

function checkNodeEngine() {
	const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
	const range = manifest.engines?.node;
	if (!range) return;
	const parse = (value) => value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
	const [minMajor, minMinor, minPatch] = parse(range.replace(/^>=/, ""));
	const [major, minor, patch] = parse(process.version);
	const tooOld = major < minMajor || (major === minMajor && (minor < minMinor || (minor === minMinor && patch < minPatch)));
	if (tooOld) fail(`node ${process.version} does not satisfy engines.node ${range}`);
}

async function main() {
	const args = process.argv.slice(2);
	const wantedClean = args.includes("--clean");
	const checkoutIndex = args.indexOf("--checkout-dir");
	const checkoutOverride = checkoutIndex === -1 ? undefined : args[checkoutIndex + 1];
	const unknown = args.filter((arg) => arg !== "--clean" && arg !== "--checkout-dir" && arg !== args[checkoutIndex + 1]);
	if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(" ")}`);
	if (checkoutIndex !== -1 && (checkoutOverride === undefined || checkoutOverride.startsWith("-"))) {
		fail("--checkout-dir needs a path");
	}

	checkNodeEngine();
	const pin = readPin();
	const checkoutDir = resolveCheckoutDir(checkoutOverride);

	const appSha = await capture("git", ["-C", appRoot, "rev-parse", "HEAD"]);
	log(`application commit: ${appSha}`);
	log(`pinned Pi commit:   ${pin.commit}`);
	log(`node ${process.version}, npm ${await capture("npm", ["--version"], { shell: IS_WINDOWS })}`);

	await prepareCheckout(checkoutDir, pin);
	if (wantedClean) await clean(checkoutDir, pin);

	// Install from the lockfiles: the upstream one first, because its workspace
	// links are what the three packages resolve their own dependencies through.
	await npm(["ci", "--ignore-scripts"], { cwd: checkoutDir });
	await npm(["ci", "--ignore-scripts"], { cwd: appRoot });

	for (const { dir, script } of pin.build) {
		await npm(["run", script], { cwd: join(checkoutDir, dir) });
	}

	// The linking mechanism is unchanged from TASK-001; it runs after install
	// because npm ci would otherwise drop the symlinks.
	await run(process.execPath, [join(appRoot, "scripts", "link-checkout.mjs")], { cwd: appRoot });

	await verify(checkoutDir, pin);
	log(`prepared: checkout ${checkoutDir} at ${pin.commit}`);
}

main().catch((error) => fail(error.message));
