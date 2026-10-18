// TASK-005.3 src/agent/builder/tool-catalog.ts
//
// The tools this deployment can grant to a child task, with the version that is
// recorded in the configuration snapshot. The catalog is application config:
// the model only *requests* names, and `authorizeTask` decides against this
// list. Versions are explicit because "which implementation actually ran" is
// part of the snapshot a reopened run compares (contract §"任务、Skill、工厂与权限").

import { ChildTools, textCheckTool, textStatsTool } from "../../multiagent/child-tools.ts";
import type { AuthorizedTool } from "./authorization.ts";

/** The version of the local text tools. Bump when their behavior changes. */
export const LOCAL_TEXT_TOOL_VERSION = "1.0.0";

/**
 * The first-version tool set: two local, side-effect-free text tools. No
 * network and no Notion write are reachable through this catalog.
 *
 * Both declare empty effects because both are pure functions of their
 * arguments: they read no resource and write none, so two tasks that hold only
 * these may run concurrently. A tool that wrote to a document, a file or a
 * service would declare the target here — or `UNKNOWN_WRITE` if the target
 * cannot be named before the call runs, which admits it exclusively.
 */
export const LOCAL_TEXT_TOOLS: readonly AuthorizedTool[] = [
	{ name: "text_stats", version: LOCAL_TEXT_TOOL_VERSION, registration: textStatsTool, extension: ChildTools, effects: { reads: [], writes: [] } },
	{ name: "text_check", version: LOCAL_TEXT_TOOL_VERSION, registration: textCheckTool, extension: ChildTools, effects: { reads: [], writes: [] } },
];

/** The tool names a policy can allow from this catalog. */
export const LOCAL_TEXT_TOOL_NAMES: readonly string[] = LOCAL_TEXT_TOOLS.map((tool) => tool.name);
