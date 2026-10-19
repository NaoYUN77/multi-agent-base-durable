type Message = {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: { arguments?: Record<string, unknown>; [key: string]: unknown };
};

export function startMcpHttpServer(options?: {
	responseMode?: "json" | "sse";
	beforeReply?: (message: Message) => void | Promise<void>;
	reply?: (message: Message) => unknown;
}): Promise<{
	url: string;
	requests: { method: string | undefined; session: string | string[] | null; body: string }[];
	close(): Promise<void>;
}>;
