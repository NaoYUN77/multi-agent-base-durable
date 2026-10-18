// TASK-005.4 src/agent/contracts/tool-effects.ts
//
// What a tool does to the world, as the tool catalog declares it.
//
// The batch runtime must decide whether two items may run at the same time. The
// only honest input to that decision is a declaration by the application, not a
// guess from the tool's name or its arguments: a task's arguments are supplied
// by the model, and "this call happens to touch document X" is not something the
// runtime can establish before the call runs.
//
// So the catalog declares it, once per tool, and the runtime derives each item's
// claim from *all* the tools that item was granted. A tool whose write target
// cannot be identified says so (`UNKNOWN_WRITE`) rather than declaring nothing:
// "no writes" would make it run concurrently with everything, which is the
// opposite of the safe reading.
//
// This type lives in the contracts layer because the catalog (`src/agent/builder`)
// declares it and the runtime reads it; neither layer may depend on the other.

/** A declared read or write target. Free-form, but stable within one deployment. */
export type ResourceId = string;

/**
 * The wildcard write target: the tool writes something whose identity cannot be
 * declared. An item holding one is admitted exclusively.
 */
export const UNKNOWN_WRITE = "*";

/** One authorized tool's declared effects. */
export type ToolEffects = {
	/** Targets the tool reads. Shared with other readers. */
	readonly reads: readonly ResourceId[];
	/**
	 * Targets the tool writes. Conflicts with every read or write of the same
	 * target. `UNKNOWN_WRITE` means the target cannot be identified.
	 */
	readonly writes: readonly ResourceId[];
};

/**
 * The claim derived from all granted tools of one item.
 *
 * The arrays are mutable on purpose: a claim is persisted inside a scheduler slot
 * document, and a `readonly T[]` is not a `JsonValue` the Durable layer can
 * store. Declaring them mutable here keeps the stored shape and the in-memory
 * shape the same type, rather than adding a second "storage" alias that would
 * drift from this one.
 */
export type ResourceClaim = {
	reads: ResourceId[];
	writes: ResourceId[];
	/** True when any granted tool declares `UNKNOWN_WRITE`. */
	exclusive: boolean;
};

/** The result of reading one catalog entry's declaration. */
export type ToolEffectsReading = { readonly ok: true; readonly effects: ToolEffects } | { readonly ok: false; readonly detail: string };

function isResourceList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/**
 * Read one tool's declared effects from application config.
 *
 * TypeScript already requires the field, so this check exists for the config
 * that arrives as data — a catalog built from a JSON file, or one written by a
 * caller that bypassed the type. An absent or malformed declaration is an
 * application error, reported rather than defaulted: defaulting to "no effects"
 * would admit an unknown writer concurrently with everything else.
 */
export function readToolEffects(value: unknown): ToolEffectsReading {
	if (typeof value !== "object" || value === null) return { ok: false, detail: "the catalog entry declares no effects" };
	const holder = value as { readonly reads?: unknown; readonly writes?: unknown };
	if (!isResourceList(holder.reads)) return { ok: false, detail: "effects.reads must be a list of non-empty resource ids" };
	if (!isResourceList(holder.writes)) return { ok: false, detail: "effects.writes must be a list of non-empty resource ids" };
	return { ok: true, effects: { reads: [...holder.reads], writes: [...holder.writes] } };
}
