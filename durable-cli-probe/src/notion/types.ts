// TASK-002 src/notion/types.ts
//
// Narrow, serializable projections of the Notion API responses this probe uses.
//
// Why a separate type layer: the task forbids handing the model a full raw Notion
// response (constraint 4). A Notion page object is large — every property, icon,
// cover, and mention — and mostly noise to a model. These types are the small,
// stable, human-meaningful slice the probe keeps, and they are plain JSON so they
// can be committed into a Durable transcript without a serializer.
//
// The direction of the mapping matters: `to*` functions in read.ts take the SDK's
// wide types and produce these narrow ones. Nothing here imports the SDK, so a
// unit test can build these values with no network and no client.

/** Notion's own identifier for a record. Treated as opaque: never parsed. */
export type NotionId = string;

/** The page/data-source/user shapes the probe projects, lowercase, as Notion spells them. */
export type NotionObjectType = "page" | "data_source" | "user" | "bot" | "block";

/** A single line of plain text pulled out of any rich-text-bearing block. */
export interface TextLine {
	/** The block type the line came from, e.g. "paragraph", "heading_1", "bulleted_list_item". */
	readonly type: string;
	/** Nesting depth, 0 for a direct child of the page. */
	readonly depth: number;
	/** Plain text with inline mentions flattened to their `plain_text`. */
	readonly text: string;
	/** True when the block has children and the probe did not descend into them. */
	readonly hasChildren: boolean;
}

/** A page or data source as returned by search: enough to choose one, nothing more. */
export interface SearchHit {
	readonly object: "page" | "data_source";
	readonly id: NotionId;
	/** The page/data-source title, flattened from whatever property carries it. */
	readonly title: string;
	readonly url: string | undefined;
	readonly lastEditedTime: string | undefined;
	/** `type` of the parent, e.g. "page_id", "database_id", "workspace". */
	readonly parentType: string | undefined;
}

/** One page of search results, plus what the connection can see. */
export interface SearchResult {
	readonly query: string | undefined;
	readonly hits: readonly SearchHit[];
	/** Total across every page the probe walked, not just this page. */
	readonly total: number;
	readonly hasMore: boolean;
	/** True when the probe stopped before Notion ran out of results. */
	readonly truncated: boolean;
}

/** A page's identity and properties, kept small: title, url, parent, and a flat property summary. */
export interface PageSummary {
	readonly id: NotionId;
	readonly title: string;
	readonly url: string | undefined;
	readonly parentType: string | undefined;
	/** `name → rendered scalar` for each property, so a database row reads as key/value lines. */
	readonly properties: Readonly<Record<string, string>>;
	readonly lastEditedTime: string | undefined;
	/** True when the probe kept fewer properties than the page has. */
	readonly propertiesTruncated: boolean;
}

/** A page's body, read from its block children. Distinct from properties: see `PageSummary`. */
export interface BlockChildren {
	readonly rootId: NotionId;
	readonly lines: readonly TextLine[];
	/** How many block objects Notion returned, before filtering to text-bearing ones. */
	readonly blockCount: number;
	/** True when the probe stopped before Notion ran out of children. */
	readonly truncated: boolean;
	/** True when at least one block had children the probe did not descend into. */
	readonly hasNestedChildren: boolean;
}

/** The bot user behind the token: the cheapest way to prove the token is valid. */
export interface BotIdentity {
	readonly id: NotionId;
	readonly name: string;
	readonly type: "bot" | "user" | "person";
	/** The workspace the bot belongs to, when Notion reports one. */
	readonly workspaceName: string | undefined;
	/** The connection owner, when Notion reports one; helps tell whose sharing applied. */
	readonly ownerType: string | undefined;
}

/** A normalized Notion failure, so callers branch on a code instead of an HTTP status. */
export interface NotionErrorInfo {
	/** The stable `code` from Notion, e.g. "unauthorized", "object_not_found", "rate_limited". */
	readonly code: string;
	readonly status: number | undefined;
	/** Notion's human-readable message. Never carries the token. */
	readonly message: string;
	/** Seconds to wait, from `Retry-After`, when the failure was a 429/529. */
	readonly retryAfterSeconds: number | undefined;
	/** Notion's request id for support, when present. */
	readonly requestId: string | undefined;
}
