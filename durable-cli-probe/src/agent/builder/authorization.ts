// TASK-005.3 src/agent/builder/authorization.ts
//
// `authorizeTask`: the program's decision about what one task may use.
//
// The model proposes a TaskSpec (a skill id and a list of requested tools); the
// policy is the *application's* answer to "which skills and tools exist in this
// deployment". Authorization is a subset decision with no silent edits:
//
//   * a requested tool the policy does not allow is a refusal, not a drop;
//   * a tool the skill requires but the spec did not request is a refusal, not
//     an addition — adding it would be widening the grant;
//   * a tool the spec requests and the policy allows is granted exactly once.
//
// The output is a `ContractValidation`, so every reason is reported together
// and the caller decides whether to refuse the task or surface the list.

import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { ContractValidation } from "../contracts/errors.ts";
import type { TaskSpec } from "../contracts/task-spec.ts";
import { readToolEffects, type ToolEffects } from "../contracts/tool-effects.ts";
import { Violations } from "../contracts/validate.ts";
import type { SkillDefinition, SkillRegistry } from "./skill-registry.ts";

/** One tool the application may grant, with the version that identifies it. */
export type AuthorizedTool = {
	/** Tool name as the model sees it (snake_case). */
	readonly name: string;
	/** Version identifier of the implementation the policy points at. */
	readonly version: string;
	/** The actual registration installed in the runtime registry. */
	readonly registration: ToolRegistration;
	/**
	 * The extension that provides the tool. The child selects exactly the
	 * extensions of its granted tools, so an extension belonging to no grant is
	 * never inherited.
	 */
	readonly extension: Extension;
	/**
	 * What the tool reads and writes, declared by the catalog.
	 *
	 * Required, not optional: the batch runtime decides which items may run
	 * concurrently from the union of their granted tools' effects, and an absent
	 * declaration would silently mean "touches nothing" — the most permissive
	 * reading of the least information. A tool whose targets cannot be named
	 * declares `UNKNOWN_WRITE` instead, which is admitted exclusively.
	 */
	readonly effects: ToolEffects;
};

/**
 * The deployment's authorization policy. Every field is explicit: there is no
 * default allow-list and no implicit inheritance from the main agent.
 */
export type TaskAuthorizationPolicy = {
	/** Loaded skill registry; resolving an id performs no IO. */
	readonly skills: SkillRegistry;
	/** Skill ids this deployment authorizes. */
	readonly allowedSkills: readonly string[];
	/** Tool names this deployment authorizes for child tasks. */
	readonly allowedTools: readonly string[];
	/** The authorized tool implementations, with their versions. */
	readonly tools: readonly AuthorizedTool[];
};

/** What one task may use, after authorization. */
export type AuthorizedCapabilities = {
	/** The resolved skill, including the instructions that will be assembled. */
	readonly skill: SkillDefinition;
	/** Exactly the requested tools that both the policy and the skill permit, in request order. */
	readonly tools: readonly AuthorizedTool[];
};

/**
 * Decide the capability set of one task.
 *
 * @param spec - a TaskSpec already validated by `validateTaskSpec`; the policy
 * is the authorization source, never the model's own description.
 * @returns `ok` with the granted skill and tool set, or every violation found.
 * Pure: no IO, no storage writes, no model calls. Idempotent: the same spec and
 * policy always produce the same decision and the same order.
 *
 * Refusals:
 * - `skill_not_allowed` — the spec names a skill the policy does not list;
 * - `skill_unknown` — the skill is allowed by name but absent from the registry;
 * - `tool_unknown` — a requested tool is not in the policy's catalog;
 * - `tool_not_allowed` — a requested tool is catalogued but not allowed;
 * - `skill_required_tool_not_requested` — the skill needs a tool the spec omits
 *   (granting it silently would widen the task's authority);
 * - `tool_catalog_duplicate` / `tool_catalog_mismatch` / `tool_extension_mismatch`
 *   — the policy itself is inconsistent, which is an application error reported
 *   instead of guessed at.
 */
export function authorizeTask(spec: TaskSpec, policy: TaskAuthorizationPolicy): ContractValidation<AuthorizedCapabilities> {
	const collect = new Violations();

	// The catalog is application config; validate it before trusting it.
	const catalog = new Map<string, AuthorizedTool>();
	for (const tool of policy.tools) {
		if (catalog.has(tool.name)) {
			collect.add("tool_catalog_duplicate", "$.tools", `tool ${tool.name} appears more than once in the catalog`);
			continue;
		}
		if (tool.registration.name !== tool.name) {
			collect.add("tool_catalog_mismatch", "$.tools", `catalog name ${tool.name} does not match registration ${tool.registration.name}`);
			continue;
		}
		// `configure` enables the extension and the tool name independently; a
		// catalog entry whose extension does not actually provide the tool would
		// authorize a tool the child never receives.
		if (!(tool.extension.tools ?? []).some((registered) => registered.name === tool.name)) {
			collect.add("tool_extension_mismatch", "$.tools", `extension ${tool.extension.name} does not provide tool ${tool.name}`);
			continue;
		}
		// Effects are what the batch runtime uses to decide concurrency. A catalog
		// entry without a well-formed declaration is an application error, not a
		// tool with no effects: the latter would run alongside any other item.
		const effects = readToolEffects(tool.effects);
		if (!effects.ok) {
			collect.add("tool_effects_missing", "$.tools", `tool ${tool.name}: ${effects.detail}`);
			continue;
		}
		catalog.set(tool.name, tool);
	}

	// The skill: allowed by policy, then resolvable by the registry. Both are
	// required — an allowed name with no manifest is not a skill.
	if (!policy.allowedSkills.includes(spec.skillId)) collect.add("skill_not_allowed", "$.skillId", `skill ${spec.skillId} is not authorized`);
	const skill = policy.skills.resolve(spec.skillId);
	if (skill === undefined) collect.add("skill_unknown", "$.skillId", `skill ${spec.skillId} is not in the registry`);

	// Requested tools: each must exist and be allowed, and the order is kept.
	const allowed = new Set(policy.allowedTools);
	const requested: AuthorizedTool[] = [];
	for (const name of spec.requestedTools) {
		const tool = catalog.get(name);
		if (tool === undefined) {
			collect.add("tool_unknown", "$.requestedTools", `tool ${name} is not in the policy's catalog`);
			continue;
		}
		if (!allowed.has(name)) {
			collect.add("tool_not_allowed", "$.requestedTools", `tool ${name} is not authorized`);
			continue;
		}
		if (!requested.some((granted) => granted.name === name)) requested.push(tool);
	}

	// The skill's own requirements are a lower bound on the grant. Adding them
	// here would authorize a tool the task did not request; dropping them would
	// leave the skill unable to do its job. Neither is silent, so both refuse.
	if (skill !== undefined) {
		for (const name of skill.manifest.requiredTools) {
			if (!spec.requestedTools.includes(name)) {
				collect.add("skill_required_tool_not_requested", "$.requestedTools", `skill ${skill.manifest.id} requires tool ${name}, which the task did not request`);
			}
			if (!allowed.has(name) || !catalog.has(name)) {
				collect.add("tool_not_allowed", "$.requestedTools", `skill ${skill.manifest.id} requires tool ${name}, which the policy does not authorize`);
			}
		}
	}

	if (collect.list.length > 0 || skill === undefined) return collect.finish(undefined as unknown as AuthorizedCapabilities);
	return collect.finish({ skill, tools: requested });
}
