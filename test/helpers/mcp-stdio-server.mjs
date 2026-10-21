// Newline-delimited JSON-RPC fixture, running in a child process.
import process from "node:process";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = PROTOCOL_VERSIONS[0];

/** What the server's own catalog advertises. */
const TOOLS = [
	{
		name: "echo",
		description: "Answer with the text it was given.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "The text to echo." } },
			required: ["text"],
			additionalProperties: false,
		},
	},
	{
		name: "fail",
		description: "Answer with a tool error that names the reason.",
		inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: [], additionalProperties: false },
	},
];

function seen(what) {
	process.stderr.write(`SEEN ${what}\n`);
}

function respond(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

/** One JSON-RPC message. `id` absent means notification: it is never answered. */
function handle(message) {
	const { id, method, params } = message;
	const notify = id === undefined || id === null;
	switch (method) {
		case "initialize": {
			const requested = params?.protocolVersion;
			const version = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST;
			seen(`initialize protocolVersion=${version} client=${params?.clientInfo?.name ?? "?"}`);
			respond(id, {
				protocolVersion: version,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "mcp-stdio-fixture", version: "1.2.3" },
				instructions: "Fixture server: one echo tool, for transport tests.",
			});
			return;
		}
		case "notifications/initialized":
			seen("notifications/initialized");
			return;
		case "ping":
			if (!notify) respond(id, {});
			return;
		case "tools/list":
			seen(`tools/list`);
			if (!notify) respond(id, { tools: TOOLS });
			return;
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			seen(`tools/call name=${name}`);
			if (name === "echo") {
				respond(id, { content: [{ type: "text", text: `echo: ${String(args.text)}` }] });
				return;
			}
			if (name === "fail") {
				// A tool-level failure: `isError`, not a JSON-RPC error, which is what
				// the spec asks a server to send when the call was understood but did
				// not succeed.
				respond(id, { content: [{ type: "text", text: `refused: ${String(args.reason ?? "no reason given")}` }], isError: true });
				return;
			}
			if (!notify) fail(id, -32602, `unknown tool ${String(name)}`);
			return;
		}
		case "resources/list":
			if (!notify) respond(id, { resources: [] });
			return;
		default:
			if (!notify) fail(id, -32601, `method not found: ${String(method)}`);
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line === "") continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		for (const item of Array.isArray(message) ? message : [message]) handle(item);
	}
});
process.stdin.on("end", () => process.exit(0));
