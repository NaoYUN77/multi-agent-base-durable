import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the checkout packages the same way the CLI does: through the symlinks
// in node_modules, with the `source` condition so TypeScript sources are read
// directly rather than the built dist.
const checkout = fileURLToPath(new URL("../base-durable-vaction-agent/pi", import.meta.url));

export default defineConfig({
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-durable$/, replacement: `${checkout}/packages/durable/src/index.ts` },
			{ find: /^@earendil-works\/pi-durable\/(.*)$/, replacement: `${checkout}/packages/durable/src/$1` },
			{ find: /^@earendil-works\/pi-ai$/, replacement: `${checkout}/packages/ai/src/index.ts` },
			{ find: /^@earendil-works\/pi-ai\/(.*)$/, replacement: `${checkout}/packages/ai/src/$1` },
			{ find: /^@earendil-works\/chord$/, replacement: `${checkout}/packages/chord/src/index.ts` },
			{ find: /^@earendil-works\/chord\/(.*)$/, replacement: `${checkout}/packages/chord/src/$1` },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
