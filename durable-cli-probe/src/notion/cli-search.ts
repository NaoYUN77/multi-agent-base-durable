// TASK-002 src/notion/cli-search.ts
//
// `npm run notion:search -- "<query>"` — POST /v1/search.
//
// Accepts an optional `--object page|data_source` and `--limit N`. With no query,
// Notion returns everything shared with the connection, which is how the probe
// answers "how many pages can this connection see?".

import { openNotionCli, printBanner, runNotionCli } from "./runtime.ts";
import { DEFAULT_SEARCH_LIMIT, search } from "./read.ts";
import { renderSearchResult } from "./read.ts";

await runNotionCli(async () => {
	const argv = process.argv.slice(2);
	let object: "page" | "data_source" | undefined;
	let limit = DEFAULT_SEARCH_LIMIT;
	const words: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--object") {
			const value = argv[++index];
			if (value !== "page" && value !== "data_source") throw new Error(`--object must be page or data_source`);
			object = value;
		} else if (arg === "--limit") {
			const value = Number(argv[++index]);
			if (!Number.isInteger(value) || value <= 0) throw new Error(`--limit must be a positive integer`);
			limit = value;
		} else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
		else words.push(arg);
	}
	const query = words.join(" ").trim();

	const { client, version, baseUrl, pinnedIp } = openNotionCli();
	printBanner("search", { version, baseUrl, pinnedIp });
	console.log(`[notion] query=${query === "" ? "(none: listing all shared)" : JSON.stringify(query)} object=${object ?? "any"}`);

	const result = await search(client, {
		...(query === "" ? {} : { query }),
		...(object === undefined ? {} : { object }),
		limit,
	});
	console.log(`[notion] results=${result.total} has_more=${result.hasMore} truncated=${result.truncated}`);
	const pages = result.hits.filter((hit) => hit.object === "page").length;
	const sources = result.hits.filter((hit) => hit.object === "data_source").length;
	console.log(`[notion] pages=${pages} data_sources=${sources}`);
	console.log(renderSearchResult(result));
});
