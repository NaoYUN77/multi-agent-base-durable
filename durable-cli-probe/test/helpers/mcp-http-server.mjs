// Streamable HTTP fixture; GET returns 405 because it has no notification stream.
import { createServer } from "node:http";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = PROTOCOL_VERSIONS[0];
const SESSION_ID = "fixture-session-1";

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
];

function result(id, value) {
	return { jsonrpc: "2.0", id, result: value };
}

function error(id, code, message) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

/** One JSON-RPC message, or `undefined` for a notification (answered with 202). */
function handle(message) {
	const { id, method, params } = message;
	const notify = id === undefined || id === null;
	switch (method) {
		case "initialize": {
			const requested = params?.protocolVersion;
			const version = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST;
			return result(id, {
				protocolVersion: version,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "mcp-http-fixture", version: "9.9.9" },
			});
		}
		case "notifications/initialized":
			return undefined;
		case "ping":
			return notify ? undefined : result(id, {});
		case "tools/list":
			return notify ? undefined : result(id, { tools: TOOLS });
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			if (name === "echo") return result(id, { content: [{ type: "text", text: `http-echo: ${String(args.text)}` }] });
			return error(id, -32602, `unknown tool ${String(name)}`);
		}
		case "resources/list":
			return notify ? undefined : result(id, { resources: [] });
		default:
			return notify ? undefined : error(id, -32601, `method not found: ${String(method)}`);
	}
}

/**
 * Start the server on an ephemeral loopback port.
 *
 * @returns the endpoint URL, the log of what it was asked, and `close()`.
 */
export async function startMcpHttpServer(options = {}) {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", async () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: request.method, session: request.headers["mcp-session-id"] ?? null, body });
			if (request.method === "GET") {
				// No server-to-client stream.
				response.writeHead(405, { allow: "POST, DELETE" }).end();
				return;
			}
			if (request.method === "DELETE") {
				response.writeHead(204).end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			let message;
			try {
				message = JSON.parse(body);
			} catch {
				response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(error(null, -32700, "parse error")));
				return;
			}
			await options.beforeReply?.(message);
			if (response.destroyed) return;
			const answers = (Array.isArray(message) ? message : [message]).map((item) => options.reply?.(item) ?? handle(item)).filter((answer) => answer !== undefined);
			if (answers.length === 0) {
				// A notification: acknowledged, with no reply body.
				response.writeHead(202, { "mcp-session-id": SESSION_ID }).end();
				return;
			}
			if (options.responseMode === "sse") {
				response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": SESSION_ID });
				response.end(answers.map((answer) => `event: message\ndata: ${JSON.stringify(answer)}\n\n`).join(""));
				return;
			}
			response.writeHead(200, { "content-type": "application/json", "mcp-session-id": SESSION_ID });
			response.end(JSON.stringify(answers.length === 1 ? answers[0] : answers));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const url = `http://127.0.0.1:${address.port}/mcp`;
	return {
		url,
		requests,
		close: () => new Promise((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}
