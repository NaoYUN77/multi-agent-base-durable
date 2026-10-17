// TASK-005.3 src/agent/builder/skill-registry.ts
//
// The controlled Skill manifest. A Skill is *data* the application assembles
// into a child agent: an id, a version, a hash, an entrypoint that points at an
// instructions file, and the tools it needs. Nothing here executes a Skill
// script, loads code from a manifest path, or follows a path out of the
// registered root — the whole module only reads files.
//
// Two properties are load-bearing:
//
//   1. **Containment.** The skill directory is resolved with `realpath` and must
//      stay under the real root; the entrypoint is resolved the same way and
//      must stay under the real skill directory. Checking the raw string for
//      `..` is not enough: a symlink can point anywhere.
//   2. **A stable identity.** `version` is the manifest's own revision and
//      `hash` is the SHA-256 of the instructions file. A running child records
//      both in its config snapshot, so a later registry change can be detected
//      instead of silently changing what an existing instance means (contract
//      §"任务、Skill、工厂与权限").

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ContractViolationError } from "../contracts/errors.ts";
import { Violations, readIdArray, readNoUnknownKeys, readObject, readSchemaVersion, readStableId, readString } from "../contracts/validate.ts";

/** Current schema version of one skill manifest. */
export const SKILL_MANIFEST_SCHEMA_VERSION = 1;

/** The file name a skill directory must carry. */
export const SKILL_MANIFEST_FILE = "skill.json";

/** The manifest as stored on disk, after validation. */
export type SkillManifest = {
	readonly schemaVersion: number;
	/** Stable id, unique across the registry. */
	readonly id: string;
	/** The skill's own revision. Part of the configuration snapshot. */
	readonly version: string;
	/** Relative path of the instructions file, inside the skill directory. */
	readonly entrypoint: string;
	/** Tool names the skill cannot work without. */
	readonly requiredTools: string[];
	readonly description?: string;
};

/** One resolved skill: the manifest, the instructions it loaded, and their hash. */
export type SkillDefinition = {
	readonly manifest: SkillManifest;
	/** The entrypoint file's text, exactly as read. */
	readonly instructions: string;
	/** Lowercase hex SHA-256 of `instructions`. */
	readonly hash: string;
	/** Absolute, resolved directory the skill was loaded from. */
	readonly directory: string;
};

/**
 * The read-only view `authorizeTask` and the config factory receive. Loaded
 * once by the application; resolving an id does no IO.
 */
export interface SkillRegistry {
	/** The skill with this id, or `undefined` when the registry does not have it. */
	resolve(id: string): SkillDefinition | undefined;
	/** Every loaded skill, in directory order (sorted by id). */
	list(): readonly SkillDefinition[];
}

/** Options of `loadSkillRegistry`. The root is explicit: there is no implicit default. */
export type LoadSkillRegistryOptions = {
	/** Absolute directory that contains one subdirectory per skill. */
	readonly root: string;
};

const MANIFEST_FIELDS: readonly string[] = ["schemaVersion", "id", "version", "entrypoint", "requiredTools", "description"];

/** Hash the exact text that will be installed as the skill's instructions. */
export function hashInstructions(instructions: string): string {
	return createHash("sha256").update(instructions, "utf8").digest("hex");
}

/**
 * True when `candidate` is the root itself or lies under it.
 *
 * Both paths must already be resolved with `realpath`; comparing unresolved
 * paths would let a symlink or a `..` segment pass the check that the real file
 * then escapes. The separator suffix is load-bearing: `/skills-other` must not
 * count as being inside `/skills`.
 */
function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A relative path that does not try to leave its directory, on either separator. */
function isContainedRelativePath(path: string): boolean {
	if (isAbsolute(path)) return false;
	const segments = path.split(/[\\/]/);
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Validate one manifest object. Returns the manifest, or reports every violation. */
function readManifest(input: unknown, path: string, collect: Violations): SkillManifest | undefined {
	const holder = readObject(input, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, MANIFEST_FIELDS);
	const schemaVersion = readSchemaVersion(holder, path, collect, [SKILL_MANIFEST_SCHEMA_VERSION]);
	const id = readStableId(holder, "id", `${path}.id`, collect);
	const version = readStableId(holder, "version", `${path}.version`, collect);
	const entrypoint = readString(holder, "entrypoint", `${path}.entrypoint`, collect);
	const requiredTools = readIdArray(holder, "requiredTools", `${path}.requiredTools`, collect) ?? [];
	const description = holder.description === undefined ? undefined : readString(holder, "description", `${path}.description`, collect);
	if (entrypoint !== undefined && !isContainedRelativePath(entrypoint)) {
		collect.add("skill_entrypoint_escape", `${path}.entrypoint`, "must be a relative path without `..` that stays inside the skill directory");
		// Refuse here rather than resolving: an absolute path or a `..` segment is
		// invalid as a manifest, and trying to resolve it would report an ENOENT
		// (or read an unrelated file) instead of the manifest rule that failed.
		return undefined;
	}
	if (schemaVersion === undefined || id === undefined || version === undefined || entrypoint === undefined) return undefined;
	return { schemaVersion, id, version, entrypoint, requiredTools, ...(description === undefined ? {} : { description }) };
}

/**
 * Load every skill under `options.root`.
 *
 * A malformed directory fails the whole load rather than being skipped: a
 * registry that silently drops the skill a plan names is how a task ends up
 * running with no instructions at all. The returned registry is immutable and
 * performs no IO; `authorizeTask` can use it as a pure dependency.
 *
 * @throws ContractViolationError with one entry per malformed manifest, escaped
 * entrypoint or duplicate id. File-system errors (a missing entrypoint, an
 * unreadable directory) are thrown as-is with the skill directory in the
 * message.
 */
export async function loadSkillRegistry(options: LoadSkillRegistryOptions): Promise<SkillRegistry> {
	const root = await realpath(options.root);
	const entries = await readdir(root, { withFileTypes: true });
	const collect = new Violations();
	const skills: SkillDefinition[] = [];
	const seen = new Set<string>();

	// Symlinked skill directories (including Windows junctions) report
	// `isSymbolicLink()`, not `isDirectory()`. Resolve them and keep the ones
	// that really are directories, so an installed link is not silently dropped.
	const candidates = entries
		.filter((candidate) => candidate.isDirectory() || candidate.isSymbolicLink())
		.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of candidates) {
		const directory = join(root, entry.name);
		const info = await stat(directory).catch(() => undefined);
		if (info?.isDirectory() !== true) continue;
		const manifestPath = join(directory, SKILL_MANIFEST_FILE);
		const raw = await readFile(manifestPath, "utf8").catch((error: unknown) => {
			throw new Error(`skill ${entry.name}: cannot read ${SKILL_MANIFEST_FILE}: ${(error as Error).message}`);
		});
		let parsed: unknown;
		try {
			// Editors on Windows may save UTF-8 with a BOM; `JSON.parse` rejects it.
			// One malformed manifest aborts the whole registry, so strip it first.
			const text = raw.startsWith(String.fromCharCode(0xfeff)) ? raw.slice(1) : raw;
			parsed = JSON.parse(text);
		} catch (error) {
			collect.add("skill_manifest_json", `$.skills.${entry.name}`, `${SKILL_MANIFEST_FILE} is not valid JSON: ${(error as Error).message}`);
			continue;
		}
		const manifest = readManifest(parsed, `$.skills.${entry.name}`, collect);
		if (manifest === undefined) continue;
		if (seen.has(manifest.id)) {
			collect.add("skill_duplicate_id", `$.skills.${entry.name}.id`, `skill id ${manifest.id} appears in more than one directory`);
			continue;
		}
		seen.add(manifest.id);

		// Resolve the directory and the entrypoint before reading: a symlinked
		// skill directory and a symlinked entrypoint are both checked against the
		// real root, not against the names on disk.
		const realDirectory = await realpath(directory);
		const candidate = resolve(realDirectory, manifest.entrypoint);
		const target = await realpath(candidate).catch((error: unknown) => {
			throw new Error(`skill ${manifest.id}: cannot resolve entrypoint ${manifest.entrypoint}: ${(error as Error).message}`);
		});
		if (!isInside(realDirectory, target)) {
			collect.add("skill_entrypoint_escape", `$.skills.${entry.name}.entrypoint`, "entrypoint resolves outside its skill directory");
			continue;
		}
		const instructions = await readFile(target, "utf8");
		if (instructions.trim() === "") {
			collect.add("skill_entrypoint_empty", `$.skills.${entry.name}.entrypoint`, "the instructions file must not be empty");
			continue;
		}
		skills.push({
			manifest,
			instructions,
			hash: hashInstructions(instructions),
			directory: realDirectory,
		});
	}

	if (collect.list.length > 0) throw new ContractViolationError(collect.list);
	const frozen = skills.map((skill) => ({ ...skill, manifest: { ...skill.manifest, requiredTools: [...skill.manifest.requiredTools] } }));
	return {
		resolve: (id) => frozen.find((skill) => skill.manifest.id === id),
		list: () => frozen,
	};
}

/** The relative path of a skill's instructions, for diagnostics. */
export function skillRelativePath(root: string, skill: SkillDefinition): string {
	return relative(root, join(skill.directory, skill.manifest.entrypoint));
}
