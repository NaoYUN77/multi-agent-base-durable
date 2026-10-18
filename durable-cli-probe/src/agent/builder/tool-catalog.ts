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
 */
export const LOCAL_TEXT_TOOLS: readonly AuthorizedTool[] = [
	{ name: "text_stats", version: LOCAL_TEXT_TOOL_VERSION, registration: textStatsTool, extension: ChildTools },
	{ name: "text_check", version: LOCAL_TEXT_TOOL_VERSION, registration: textCheckTool, extension: ChildTools },
];

/** The tool names a policy can allow from this catalog. */
export const LOCAL_TEXT_TOOL_NAMES: readonly string[] = LOCAL_TEXT_TOOLS.map((tool) => tool.name);
