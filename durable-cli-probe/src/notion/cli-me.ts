// TASK-002 src/notion/cli-me.ts
//
// `npm run notion:me` — GET /v1/users/me.
//
// The token-validity check with no sharing requirement: if this fails with
// `unauthorized`, the token is wrong; if it succeeds, the token is good and any
// later `object_not_found` is a sharing problem, not a credential problem.

import { openNotionCli, printBanner, runNotionCli } from "./runtime.ts";
import { usersMe } from "./read.ts";

await runNotionCli(async () => {
	const { client, version, baseUrl, pinnedIp } = openNotionCli();
	printBanner("users.me", { version, baseUrl, pinnedIp });

	const me = await usersMe(client);
	console.log(`[notion] bot id=${me.id}`);
	console.log(`[notion] name=${me.name}`);
	console.log(`[notion] type=${me.type}`);
	console.log(`[notion] workspace=${me.workspaceName ?? "(not reported)"}`);
	console.log(`[notion] owner=${me.ownerType ?? "(not reported)"}`);
	console.log("[notion] token is valid");
});
