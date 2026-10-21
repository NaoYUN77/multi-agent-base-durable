import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type CallToolResult, type Tool } from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "./config.ts";

export const MCP_CLIENT_NAME = "durable-cli-probe";
export const MCP_CLIENT_VERSION = "0.0.0";
export type McpConnectionState = "idle" | "connecting" | "connected" | "failed";

export type McpServerStatus = {
	readonly name: string;
	readonly transport: "stdio" | "http";
	readonly target: string;
	readonly state: McpConnectionState;
	readonly serverInfo?: { readonly name: string; readonly version: string };
	readonly protocolVersion?: string;
	readonly instructions?: string;
	readonly tools: readonly string[];
	readonly resources: readonly string[];
	readonly pid?: number;
	readonly error?: string;
};

type Connection = {
	client: McpClient;
	state: McpConnectionState;
	attempt?: Promise<McpServerStatus>;
	serverInfo?: { readonly name: string; readonly version: string };
	protocolVersion?: string;
	instructions?: string;
	tools: readonly Tool[];
	resources: readonly string[];
	pid?: number;
	error?: string;
};

export type McpManagerOptions = {
	readonly servers: readonly McpServerConfig[];
	readonly requestTimeoutMs?: number;
};

type RequestOptions = { signal?: AbortSignal };

export type McpManager = {
	readonly servers: readonly McpServerConfig[];
	status(): readonly McpServerStatus[];
	connect(name: string): Promise<McpServerStatus>;
	disconnect(name: string): Promise<void>;
	listTools(server: string, options?: RequestOptions): Promise<readonly Tool[]>;
	callTool(server: string, tool: string, args?: Record<string, unknown>, options?: RequestOptions): Promise<CallToolResult>;
	close(): Promise<void>;
};

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function targetOf(config: McpServerConfig): string {
	if (config.transport === "stdio") return config.command.split(/[\\/]/).at(-1) ?? "stdio";
	try {
		const url = new URL(config.url);
		return `${url.origin}${url.pathname}`;
	} catch {
		return "HTTP endpoint";
	}
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(new Error("MCP request cancelled"));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("MCP request cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export function createMcpManager(options: McpManagerOptions): McpManager {
	const servers = [...options.servers];
	const byName = new Map(servers.map((server) => [server.name, server]));
	const connections = new Map<string, Connection>();
	let closed = false;
	let closing: Promise<void> | undefined;

	function configured(name: string): McpServerConfig {
		const config = byName.get(name);
		if (config === undefined) throw new Error(`no MCP server named ${name} is configured`);
		return config;
	}

	function statusOf(config: McpServerConfig): McpServerStatus {
		const connection = connections.get(config.name);
		return {
			name: config.name,
			transport: config.transport,
			target: targetOf(config),
			state: connection?.state ?? "idle",
			...(connection?.serverInfo === undefined ? {} : { serverInfo: connection.serverInfo }),
			...(connection?.protocolVersion === undefined ? {} : { protocolVersion: connection.protocolVersion }),
			...(connection?.instructions === undefined ? {} : { instructions: connection.instructions }),
			tools: connection?.tools.map((tool) => tool.name) ?? [],
			resources: connection?.resources ?? [],
			...(connection?.pid === undefined ? {} : { pid: connection.pid }),
			...(connection?.error === undefined ? {} : { error: connection.error }),
		};
	}

	function fail(connection: Connection, message: string): void {
		connection.state = "failed";
		connection.error = message;
		connection.tools = [];
		connection.resources = [];
		connection.pid = undefined;
	}

	function ensure(name: string): Promise<McpServerStatus> {
		const config = configured(name);
		if (closed) return Promise.reject(new Error("MCP manager is closed"));
		const existing = connections.get(name);
		if (existing?.state === "connected") return Promise.resolve(statusOf(config));
		if (existing?.attempt !== undefined) return existing.attempt;

		const client = new McpClient({
			name: MCP_CLIENT_NAME,
			version: MCP_CLIENT_VERSION,
			...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
		});
		const connection: Connection = { client, state: "connecting", tools: [], resources: [] };
		connections.set(name, connection);
		client.onClose(() => {
			if (connections.get(name) === connection) fail(connection, "MCP connection closed unexpectedly");
		});
		connection.attempt = (async () => {
			try {
				await existing?.client.close().catch(() => {});
				if (connections.get(name) !== connection || closed) return statusOf(config);
				const transport = config.transport === "http"
					? new StreamableHttpTransport({ url: config.url, headers: { ...config.headers } })
					: new StdioTransport({ command: config.command, args: [...config.args], env: { ...config.env }, ...(config.cwd === undefined ? {} : { cwd: config.cwd }) });
				const initialized = await client.connect(transport);
				const tools = client.serverCapabilities?.tools === undefined ? [] : await client.listTools();
				const resources = client.serverCapabilities?.resources === undefined ? []
					: await client.listResources().then((list) => list.map((resource) => resource.uri), () => []);
				// Only the current attempt may publish a live connection after an await.
				if (connections.get(name) !== connection || closed) {
					await client.close().catch(() => {});
					return statusOf(config);
				}
				if (client.connectionState !== "connected") throw new Error("MCP connection closed");
				Object.assign(connection, {
					state: "connected", tools, resources,
					serverInfo: { name: initialized.serverInfo.name, version: initialized.serverInfo.version },
					protocolVersion: initialized.protocolVersion,
					instructions: initialized.instructions,
					pid: transport instanceof StdioTransport ? transport.pid : undefined,
					error: undefined,
				});
			} catch {
				await client.close().catch(() => {});
				if (connections.get(name) === connection) fail(connection, "MCP connection failed");
			} finally {
				connection.attempt = undefined;
			}
			return statusOf(config);
		})();
		return connection.attempt;
	}

	async function disconnect(name: string): Promise<void> {
		configured(name);
		const connection = connections.get(name);
		connections.delete(name);
		if (connection !== undefined) {
			await connection.client.close().catch(() => {});
			await connection.attempt;
		}
	}

	async function ready(server: string, signal?: AbortSignal): Promise<Connection> {
		if (signal?.aborted) throw new Error("MCP request cancelled");
		const status = await waitWithSignal(ensure(server), signal);
		if (closed) throw new Error("MCP manager is closed");
		const connection = connections.get(server);
		if (status.state !== "connected" || connection?.state !== "connected") throw new Error("MCP server is not connected");
		return connection;
	}

	return {
		servers,
		status: () => servers.map(statusOf),
		connect: async (name) => await ensure(name),
		disconnect,
		listTools: async (server, request = {}) => {
			try {
				return (await ready(server, request.signal)).tools;
			} catch {
				throw new Error(closed ? "MCP manager is closed" : request.signal?.aborted ? "MCP request cancelled" : "MCP tool catalog is unavailable");
			}
		},
		callTool: async (server, tool, args, request = {}) => {
			let connection: Connection;
			try {
				connection = await ready(server, request.signal);
				return await connection.client.callTool(tool, args, request);
			} catch {
				if (request.signal?.aborted) return errorResult("MCP tool call cancelled");
				if (closed) return errorResult("MCP manager is closed");
				return errorResult(byName.has(server) ? `MCP server ${server} tool call failed; the request was not retried` : "MCP server is not configured");
			}
		},
		close: () => {
			if (closing !== undefined) return closing;
			closed = true;
			closing = Promise.all(servers.map((server) => disconnect(server.name))).then(() => {});
			return closing;
		},
	};
}

export { toLlmContent };
