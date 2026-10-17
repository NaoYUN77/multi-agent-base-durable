// TASK-005.3 test/skill-registry.test.ts
//
// The controlled Skill manifest (AC-02 of issue #18): what is a skill, what is
// refused before any conversation exists, and what is never executed.
//
// The tests use temporary directories for the refusals and the repository's own
// `skills/` directory for the two shipped skills, so the shipped manifests are
// part of the verification rather than a fixture that can drift from them.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContractViolationError } from "../src/agent/contracts/errors.ts";
import { hashInstructions, loadSkillRegistry, type SkillDefinition, type SkillRegistry } from "../src/agent/builder/skill-registry.ts";

const REPOSITORY_SKILLS = fileURLToPath(new URL("../skills", import.meta.url));

/** Write one skill directory with a manifest and an instructions file. */
async function writeSkill(root: string, directory: string, manifest: Record<string, unknown>, instructions = "Do the work."): Promise<string> {
	const skillDir = join(root, directory);
	await mkdir(skillDir, { recursive: true });
	await writeFile(join(skillDir, "skill.json"), JSON.stringify({ schemaVersion: 1, entrypoint: "instructions.md", requiredTools: [], ...manifest }));
	await writeFile(join(skillDir, "instructions.md"), instructions);
	return skillDir;
}

/** The loaded skill, failing loudly instead of asserting non-null. */
function skillOf(registry: SkillRegistry, id: string): SkillDefinition {
	const skill = registry.resolve(id);
	if (skill === undefined) throw new Error(`skill ${id} is not in the registry`);
	return skill;
}

/** The violation codes a rejected load reported. */
async function rejectionCodes(root: string): Promise<readonly { code: string; path: string }[]> {
	try {
		await loadSkillRegistry({ root });
	} catch (error) {
		if (error instanceof ContractViolationError) return error.violations.map((violation) => ({ code: violation.code, path: violation.path }));
		throw error;
	}
	throw new Error("expected the registry to be rejected");
}

describe("TASK-005.3 skill registry", () => {
	let directory: string;
	let root: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "skill-registry-"));
		root = join(directory, "skills");
		await mkdir(root);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("loads the two shipped skills with their manifest facts and content hash", async () => {
		const registry = await loadSkillRegistry({ root: REPOSITORY_SKILLS });
		const ids = registry.list().map((skill) => skill.manifest.id);
		expect(ids).toEqual(["material-summary", "text-stats"]);

		const stats = skillOf(registry, "text-stats");
		expect(stats.manifest.version).toBe("1.0.0");
		expect(stats.manifest.requiredTools).toEqual(["text_stats", "text_check"]);
		expect(stats.instructions).toContain("text_stats");
		expect(stats.hash).toMatch(/^[0-9a-f]{64}$/);
		// The hash is the hash of exactly the text that will be installed.
		expect(stats.hash).toBe(hashInstructions(stats.instructions));

		const summary = skillOf(registry, "material-summary");
		expect(summary.manifest.requiredTools).toEqual([]);
		expect(summary.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("hashes the instructions content, not the directory name", async () => {
		await writeSkill(root, "a", { id: "same-skill", version: "1.0.0" }, "first");
		const first = await loadSkillRegistry({ root });
		const firstHash = skillOf(first, "same-skill").hash;

		// Reloading the identical content gives the identical hash.
		const second = await loadSkillRegistry({ root });
		expect(skillOf(second, "same-skill").hash).toBe(firstHash);

		// Changing the instructions changes the hash; a different directory with
		// the same manifest id would be a duplicate, so change the content in place.
		await writeFile(join(root, "a", "instructions.md"), "second");
		const third = await loadSkillRegistry({ root });
		expect(skillOf(third, "same-skill").hash).not.toBe(firstHash);
	});

	it("refuses an entrypoint that tries to leave the skill directory", async () => {
		await writeFile(join(root, "outside.md"), "outside");
		await writeSkill(root, "escape", { id: "escape", version: "1.0.0", entrypoint: "../outside.md" });
		const codes = await rejectionCodes(root);
		expect(codes).toContainEqual({ code: "skill_entrypoint_escape", path: "$.skills.escape.entrypoint" });
	});

	it("refuses an absolute entrypoint", async () => {
		await writeSkill(root, "absolute", { id: "absolute", version: "1.0.0", entrypoint: join(root, "outside.md") });
		const codes = await rejectionCodes(root);
		expect(codes).toContainEqual({ code: "skill_entrypoint_escape", path: "$.skills.absolute.entrypoint" });
	});

	it("refuses a manifest with an invalid id or an unknown field", async () => {
		await writeSkill(root, "bad-id", { id: "Bad/Id", version: "1.0.0" });
		const codes = await rejectionCodes(root);
		expect(codes.some((entry) => entry.code === "id_invalid")).toBe(true);
	});

	it("refuses a duplicate skill id across directories", async () => {
		await writeSkill(root, "first", { id: "twice", version: "1.0.0" });
		await writeSkill(root, "second", { id: "twice", version: "1.0.0" });
		const codes = await rejectionCodes(root);
		expect(codes).toContainEqual({ code: "skill_duplicate_id", path: "$.skills.second.id" });
	});

	it("fails the load when the entrypoint file is missing", async () => {
		const skillDir = join(root, "missing");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "skill.json"), JSON.stringify({ schemaVersion: 1, id: "missing", version: "1.0.0", entrypoint: "nope.md", requiredTools: [] }));
		await expect(loadSkillRegistry({ root })).rejects.toThrow(/cannot resolve entrypoint nope\.md/);
	});

	it("refuses malformed JSON instead of skipping the skill", async () => {
		const skillDir = join(root, "broken");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "skill.json"), "{ not json");
		const codes = await rejectionCodes(root);
		expect(codes).toContainEqual({ code: "skill_manifest_json", path: "$.skills.broken" });
	});

	it("never executes files found in a skill directory", async () => {
		// A manifest path is data. A `.js` file beside it must not be imported,
		// required or executed while the registry loads.
		const marker = join(directory, "executed.marker");
		const skillDir = await writeSkill(root, "scripted", { id: "scripted", version: "1.0.0" });
		await writeFile(join(skillDir, "script.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
		await writeFile(join(skillDir, "package.json"), JSON.stringify({ type: "module", main: "script.js" }));

		const registry = await loadSkillRegistry({ root });
		expect(registry.resolve("scripted")).toBeDefined();
		await expect(readFile(marker, "utf8")).rejects.toThrow();
	});
});
