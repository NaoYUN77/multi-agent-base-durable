// TASK-002 src/notion/cli-read-page.ts
//
// `npm run notion:read-page -- "<page_id>"` — GET /v1/pages/{page_id} plus
// GET /v1/blocks/{block_id}/children.
//
// Both are shown, in that order, because the task's acceptance criteria ask to
// see the difference between a page's properties and its block children: the
// first is the row's columns, the second is its body. Either can be empty while
// the other is populated, which the output makes visible.

import { requirePageId, loadNotionConfig } from "../config.ts";
import { openNotionCli, printBanner, runNotionCli } from "./runtime.ts";
import { blockChildren, pageSummary, renderBlockLines } from "./read.ts";

await runNotionCli(async () => {
	const pageArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
	// `loadNotionConfig()` and `requirePageId()` both throw NotionConfigError,
	// which runNotionCli maps to exit code 2 (configuration, not an API failure).
	const config = loadNotionConfig();
	const pageId = requirePageId(config, pageArg);

	const { client, version, baseUrl, pinnedIp } = openNotionCli();
	printBanner("pages.retrieve + blocks.children.list", { version, baseUrl, pinnedIp });
	console.log(`[notion] page_id=${pageId}`);

	// ── properties ──────────────────────────────────────────────────────────
	const page = await pageSummary(client, pageId);
	console.log(`[notion] page title=${JSON.stringify(page.title)}`);
	console.log(`[notion] page url=${page.url ?? "(none)"} parent=${page.parentType ?? "(none)"}`);
	console.log(`[notion] properties (${Object.keys(page.properties).length}${page.propertiesTruncated ? ", truncated" : ""}):`);
	for (const [name, value] of Object.entries(page.properties)) console.log(`[notion]   ${name} = ${value}`);

	// ── block children ──────────────────────────────────────────────────────
	const children = await blockChildren(client, pageId);
	console.log(
		`[notion] blocks=${children.blockCount} lines=${children.lines.length} nested=${children.hasNestedChildren} truncated=${children.truncated}`,
	);
	console.log("[notion] --- block children ---");
	console.log(renderBlockLines(children));
});
