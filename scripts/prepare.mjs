// TASK-004 scripts/prepare.mjs
//
// One repeatable entry point that takes a fresh clone to a state where
// `npm run typecheck` and `npm run lint` can run. It is the only place that
// knows the order of operations; .github/workflows/ci.yml calls this script,
// so local preparation and CI preparation cannot drift apart.
//
// Order:
//   1. parse arguments strictly (before any fetch, install or delete)
//   2. read the pinned dependency config   (pi-pin.json)
//   3. prepare the Pi checkout at the pinned commit
//   4. install dependencies from the app and upstream lockfiles
//      (npm ci --ignore-scripts)
//   5. hydrate the generated model data from the pinned catalog revision
//   6. build the type artifacts the app's typecheck needs
//      (Chord -> Telemetry -> Pi AI build:offline -> Durable -> TUI -> MCP)
//   7. link the five Pi packages (scripts/link-checkout.mjs)
//   8. verify revision, package identity, and link targets
//
// Deliberate non-actions:
//   * the upstream `npm run check` is never used: it runs
//     `biome check --write`, which rewrites files.
//   * the upstream full `build` and `generate-models` are never used: no live
//     provider-catalog refresh happens. `ai`'s `build:offline` is used instead,
//     fed by step 5.
//
// Why step 5 exists (the three-package chain alone does not build on a fresh
// clone): `packages/ai` imports `src/providers/data/*.json` while compiling,
// and upstream gitignores that directory — the files are generated, not
// committed, so a fresh checkout has none and `tsc` fails with TS2307 for every
// provider. Upstream's own offline path is the model catalog revision pinned in
// the checkout's `nix/model-catalog.json`; step 5 downloads exactly that
// revision, checks the bytes hash back to it, and runs upstream's
// `hydrate-model-catalog.ts`. Telemetry appears in the chain for the same class
// of reason: `packages/ai/src/types.ts` imports it.
//
// Safety rules this script holds to:
//   * Arguments are parsed in one strict pass first, so an unknown argument, a
//     missing value or a repeated option fails before anything is touched.
//   * An existing checkout is never rewritten or deleted. A revision mismatch
//     or a dirty checkout is a hard failure with the evidence printed.
//   * The one exception is a checkout this script left half-initialized itself:
//     `git init` writes `.git` before the first commit exists, so an
//     interrupted first run leaves a repository with no HEAD. That state is
//     recognized and completed, but only when the tree holds nothing except
//     `.git`, so no user content can be involved.
//   * `--clean` validates every delete target before the first delete: each
//     target must resolve inside the app or inside the checkout, even through a
//     symlinked intermediate directory. A config that escapes is refused, and
//     nothing is deleted.
//   * The resolved checkout directory is passed to the linker as PI_CHECKOUT,
//     so `--checkout-dir` cannot make preparation and linking disagree.
//
// Usage:
//   node scripts/prepare.mjs [--clean] [--checkout-dir <path>]
//     --clean                 drop generated artifacts first (app node_modules
//                             and the pinned packages' dist); proves nothing
//                             pre-existing is relied upon
//     --checkout-dir <path>   checkout location; wins over the PI_CHECKOUT
//                             environment variable, which in turn wins over the
//                             default. The same resolved path is handed to
//                             link-checkout.mjs.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "..");
const pinPath = join(appRoot, "pi-pin.json");

/** Where link-checkout.mjs looks when PI_CHECKOUT is unset. */
const DEFAULT_CHECKOUT = join(appRoot, "base-durable-vaction-agent", "pi");

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

/** Run a command and return its stdout, or undefined when it exits non-zero. */
function tryCapture(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", (error) => reject(new Error(`${command} could not be started: ${error.message}`)));
		child.on("close", (code) => resolvePromise(code === 0 ? stdout.trim() : undefined));
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

/**
 * Parse argv in one strict pass. Unknown arguments, a missing value and a
 * repeated option all fail here, which is before any fetch, install or delete.
 */
function parseArgs(argv) {
	const options = { clean: false, checkoutDir: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--clean") {
			if (options.clean) throw new Error("--clean was given twice");
			options.clean = true;
			continue;
		}
		if (arg === "--checkout-dir") {
			if (options.checkoutDir !== undefined) throw new Error("--checkout-dir was given twice");
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("-")) throw new Error("--checkout-dir needs a path");
			options.checkoutDir = value;
			index++;
			continue;
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

/** A checkout-relative path: not absolute, not empty, and never containing "..". */
function isCheckoutRelativePath(value) {
	return (
		typeof value === "string" &&
		value !== "" &&
		!isAbsolute(value) &&
		!value.split(/[\\/]/).includes("..")
	);
}

function readPin(configPath = pinPath) {
	let pin;
	try {
		pin = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`cannot read ${pinPath}: ${error.message}`);
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
		if (!isCheckoutRelativePath(entry.dir)) {
			problems.push(`package dir must stay inside the checkout: ${JSON.stringify(entry.dir)}`);
		}
	}
	if (!Array.isArray(pin.build) || pin.build.length === 0) {
		problems.push("build must be a non-empty array");
	}
	for (const entry of pin.build ?? []) {
		if (!isCheckoutRelativePath(entry.dir)) {
			problems.push(`build dir must stay inside the checkout: ${JSON.stringify(entry.dir)}`);
		}
	}
	if (typeof pin.modelCatalog?.endpoint !== "string" || !pin.modelCatalog.endpoint.includes("{revision}")) {
		problems.push("modelCatalog.endpoint must be a URL template containing {revision}");
	}
	if (problems.length > 0) throw new Error(`pi-pin.json is invalid: ${problems.join("; ")}`);
	return pin;
}

/** The checkout path this run will use: CLI, then PI_CHECKOUT, then the default. */
function resolveCheckoutDir(cliOverride) {
	const chosen = cliOverride ?? process.env.PI_CHECKOUT ?? DEFAULT_CHECKOUT;
	return resolve(chosen);
}

async function ensureOrigin(checkoutDir, pin) {
	const existing = await tryCapture("git", ["-C", checkoutDir, "remote", "get-url", "origin"]);
	if (existing === pin.repository) return;
	await run("git", ["-C", checkoutDir, "remote", existing === undefined ? "add" : "set-url", "origin", pin.repository]);
}

async function fetchPinned(checkoutDir, pin) {
	// Fetch by SHA: the pinned commit is reachable from the official remote, so
	// no branch or tag has to be guessed and no full clone is needed. Both
	// commands are idempotent, which is what makes an interrupted run resumable.
	await run("git", ["-C", checkoutDir, "fetch", "--depth", "1", "origin", pin.commit]);
	await run("git", ["-C", checkoutDir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"]);
}

/**
 * Make sure the checkout exists, is a git repository, is at the pinned commit,
 * and has no local modifications. An existing checkout is reused as-is and is
 * never re-fetched or deleted; the single exception is a checkout this script
 * left half-initialized (see the header).
 */
async function prepareCheckout(checkoutDir, pin) {
	if (existsSync(checkoutDir) && !existsSync(join(checkoutDir, ".git"))) {
		fail(`${checkoutDir} exists but is not a git repository. Point PI_CHECKOUT (or --checkout-dir) at a real checkout, or remove the directory yourself.`);
	}

	if (existsSync(join(checkoutDir, ".git"))) {
		log(`existing checkout at ${checkoutDir}`);
		const head = await tryCapture("git", ["-C", checkoutDir, "rev-parse", "--verify", "HEAD"]);
		if (head === undefined) {
			// `git init` writes .git before any commit exists, so a first run that
			// failed during fetch (network, Ctrl-C, killed process) leaves a
			// repository with no HEAD. Completing it is safe only while the tree
			// holds nothing but that .git, so nothing of the user's is at stake.
			const entries = readdirSync(checkoutDir).filter((entry) => entry !== ".git");
			if (entries.length > 0) {
				fail(`${checkoutDir} has no HEAD but is not empty (${entries.join(", ")}); refusing to touch it. Move it aside, or point PI_CHECKOUT / --checkout-dir somewhere else.`);
			}
			log("checkout has an interrupted initialization (no HEAD, empty tree); completing it");
			await ensureOrigin(checkoutDir, pin);
			await fetchPinned(checkoutDir, pin);
		} else if (head !== pin.commit) {
			fail(`checkout revision conflict: pinned ${pin.commit}, found ${head}. Move the checkout aside or point PI_CHECKOUT / --checkout-dir somewhere else; this script never rewrites a checkout for you.`);
		} else {
			const dirty = await capture("git", ["-C", checkoutDir, "status", "--porcelain"]);
			if (dirty !== "") {
				fail(`checkout has local modifications; refusing to install and build on top of them:\n${dirty}`);
			}
		}
	} else {
		log(`no checkout at ${checkoutDir}; fetching the pinned commit from ${pin.repository}`);
		await run("git", ["init", "-q", "-b", "main", checkoutDir]);
		await ensureOrigin(checkoutDir, pin);
		await fetchPinned(checkoutDir, pin);
	}

	const actual = await capture("git", ["-C", checkoutDir, "rev-parse", "--verify", "HEAD"]);
	if (actual !== pin.commit) fail(`checkout is at ${actual}, pinned ${pin.commit}`);

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

/**
 * Resolve a delete target, refusing anything that escapes `root` — including
 * through a symlinked or junctioned intermediate directory. Returns undefined
 * when the parent does not exist (nothing to delete). Every target is resolved
 * this way before the first delete happens.
 */
function resolveDeleteTarget(root, target, label) {
	const realRoot = realpathSync.native(root);
	const resolved = resolve(target);
	const parent = dirname(resolved);
	if (!existsSync(parent)) return undefined;
	const realParent = realpathSync.native(parent);
	if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
		throw new Error(`--clean refuses ${label}: ${parent} resolves to ${realParent}, which is outside ${realRoot}`);
	}
	return join(realParent, basename(resolved));
}

async function clean(checkoutDir, pin) {
	log("--clean: removing generated artifacts (app node_modules and the pinned packages' dist)");

	// Resolve and check every target first. A config that points outside, or a
	// symlinked intermediate directory, must abort the whole step without
	// deleting anything at all.
	const targets = [];
	const appModules = resolveDeleteTarget(appRoot, join(appRoot, "node_modules"), "the app's node_modules");
	if (appModules !== undefined) targets.push(appModules);
	for (const { dir } of pin.packages) {
		const dist = resolveDeleteTarget(checkoutDir, join(checkoutDir, dir, "dist"), `${dir}/dist`);
		if (dist !== undefined) targets.push(dist);
	}

	for (const target of targets) {
		// fs.rmSync does not follow symlinks: a linked entry is unlinked, its
		// target is left alone.
		log(`--clean: rm -rf ${target}`);
		rmSync(target, { recursive: true, force: true });
	}
}

/**
 * Regenerate the checkout's model data from the revision the pinned commit
 * declares, using upstream's own hydration command.
 *
 * This runs unconditionally, even when data already exists: a checkout that was
 * hydrated from a live catalog holds different bytes (verified on 2026-10-13:
 * the structure hash and 17 of 42 provider files differed), and the app must
 * typecheck against the same data locally and in CI. Only this gitignored,
 * generated directory is touched.
 */
async function ensureModelData(checkoutDir, pin) {
	const aiDir = join(checkoutDir, "packages", "ai");
	const revisionFile = join(checkoutDir, "nix", "model-catalog.json");
	if (!existsSync(revisionFile)) {
		fail(`${revisionFile} is missing, so the pinned commit declares no model catalog revision`);
	}
	const revision = JSON.parse(readFileSync(revisionFile, "utf8")).revision;
	if (!/^sha256-[0-9a-f]{64}$/.test(revision ?? "")) {
		fail(`${revisionFile} carries no usable revision: ${JSON.stringify(revision)}`);
	}

	const url = pin.modelCatalog.endpoint.replace("{revision}", revision);
	log(`model catalog revision: ${revision}`);
	log(`$ GET ${url}`);
	let bytes;
	try {
		const response = await fetch(url);
		if (!response.ok) fail(`catalog revision ${revision} is unavailable: HTTP ${response.status}`);
		bytes = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		fail(`cannot download the model catalog: ${error.message}`);
	}
	// The revision is the sha256 of the bytes, so this proves the download is
	// exactly the pinned catalog and not a newer or truncated one.
	const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== revision) fail(`catalog bytes hash to ${actual}, but the pin says ${revision}`);

	const catalogPath = join(tmpdir(), `pi-model-catalog-${revision.slice("sha256-".length, 20)}.json`);
	try {
		writeFileSync(catalogPath, bytes);
		await run(process.execPath, [join(aiDir, "scripts", "hydrate-model-catalog.ts"), catalogPath], { cwd: aiDir });
	} finally {
		rmSync(catalogPath, { force: true });
	}
	await npm(["run", "check:model-data"], { cwd: aiDir });
}

async function verify(checkoutDir, pin) {
	const problems = [];

	const actual = await capture("git", ["-C", checkoutDir, "rev-parse", "--verify", "HEAD"]);
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
	const options = parseArgs(process.argv.slice(2));

	checkNodeEngine();
	const pin = readPin();
	const checkoutDir = resolveCheckoutDir(options.checkoutDir);

	const appSha = await capture("git", ["-C", appRoot, "rev-parse", "HEAD"]);
	log(`application commit: ${appSha}`);
	log(`pinned Pi commit:   ${pin.commit}`);
	log(`checkout directory: ${checkoutDir}`);
	log(`node ${process.version}, npm ${await capture("npm", ["--version"], { shell: IS_WINDOWS })}`);

	await prepareCheckout(checkoutDir, pin);
	if (options.clean) await clean(checkoutDir, pin);

	// Install from the lockfiles: the upstream one first, because its workspace
	// links are what the three packages resolve their own dependencies through.
	await npm(["ci", "--ignore-scripts"], { cwd: checkoutDir });
	await npm(["ci", "--ignore-scripts"], { cwd: appRoot });

	await ensureModelData(checkoutDir, pin);

	for (const { dir, script } of pin.build) {
		await npm(["run", script], { cwd: join(checkoutDir, dir) });
	}

	// The linking mechanism is unchanged from TASK-001; it runs after install
	// because npm ci would otherwise drop the symlinks. PI_CHECKOUT is passed
	// explicitly so the linker can never disagree with --checkout-dir.
	await run(process.execPath, [join(appRoot, "scripts", "link-checkout.mjs")], {
		cwd: appRoot,
		env: { ...process.env, PI_CHECKOUT: checkoutDir },
	});

	await verify(checkoutDir, pin);
	log(`prepared: checkout ${checkoutDir} at ${pin.commit}`);
}

// Importable for the fixtures in TASK-004-VERIFICATION.md: importing this file
// must not run anything, so the CLI entry point is guarded.
export { isCheckoutRelativePath, parseArgs, readPin, resolveDeleteTarget };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => fail(error.message));
}
