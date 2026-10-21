// TASK-005.4 test/helpers/batch-watch.mjs
//
// The crash watcher: a worker thread that polls the session's SQLite file while
// the batch runs on the main thread, and kills the process the moment the
// database reaches one of the four states AC-06 names.
//
// Why a thread and a kill rather than a pause: a durable agent round runs as one
// uninterrupted microtask chain. `setImmediate` and `setTimeout` callbacks in the
// running process are not reached until the whole batch has settled, so nothing
// in that process can observe its own intermediate commits. A second thread has
// its own event loop and its own SQLite connection, so it sees every commit as
// it lands. The kill is then a real `SIGKILL` of this process — no shutdown path
// runs, which is the point.
//
// Reads are raw SQL against the durable schema plus one materialised document
// (the task ledger), because the cheapest true signal is not always a column.
// Documents are stored as a base revision plus deltas; the ledger's claim and
// its round status are deltas, so they have to be applied rather than guessed
// from row presence.
//
// Two of the four states are only a couple of commits wide — the round claims
// its slot and opens its attempt in one commit, the child conversation is
// created in the next, and the round's input is submitted in the one after
// that. Since a commit takes about the same time as a poll, catching those
// states is a race against the runner, and the loop below is shaped by that
// race: every statement is prepared once, document ids and the materialised
// ledger are cached until their revisions actually change, and each fact is
// latched the first time it becomes true and never queried again. What is left
// per poll is a handful of primary-key lookups and one `MAX(seq)`.
//
// workerData:
//   dbPath      - the SQLite file to poll
//   taskId      - the business task whose lifecycle is being watched
//   round       - the round whose submission / result the watcher looks for
//   boundary    - "claim-not-submitted" | "created-not-input" |
//                 "result-not-returned" | "retry-wait"
//   markerPath  - written (and flushed) immediately before the kill, so the test
//                 can prove the kill happened at the intended state
//   pid         - the process to kill (the runner passes its own pid)

import { openSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { apply } from "@earendil-works/chord/delta";

const { dbPath, taskId, round, boundary, markerPath, pid } = workerData;

const LEDGER_KIND = JSON.stringify("app.multiagent.task-ledger");
const RESULT_KIND = JSON.stringify("app.agent.task-result");
const ROUND_REQUEST = JSON.stringify(`multiagent-round:${taskId}:${round}`);
const LEDGER_KEY = JSON.stringify(taskId);
const RESULT_KEY = JSON.stringify(`res.${taskId}.r${round}`);

const SQL = {
	document: "SELECT id FROM documents WHERE kind = ? AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1",
	maxSeq: "SELECT MAX(seq) AS seq FROM document_revisions WHERE document_id = ?",
	base: "SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1",
	tail: "SELECT kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq",
	child: "SELECT id FROM conversations WHERE owner_task_id IS NOT NULL LIMIT 1",
	submission: "SELECT status FROM submissions WHERE request_id = ? ORDER BY id DESC LIMIT 1",
};

const reached = {
	"claim-not-submitted": (state) => state.claim && !state.submitted,
	"created-not-input": (state) => state.child && !state.submitted,
	"result-not-returned": (state) => state.answered && !state.result,
	"retry-wait": (state) => state.retryWait,
	// TASK-005.7 (AC-04). The review decision is its own commit, and a rework is a
	// round the decision starts, so the four windows a crash can land in are:
	//
	//   review-pending   the round settled at awaiting_review and the review call
	//                    has not committed its decision yet;
	//   review-accepted  the accept is committed, before the tool call returned;
	//   rework-decided   the rejection is committed, and the next round has not been
	//                    claimed yet — the window between deciding and executing;
	//   rework-settled   the revision round settled, before the tool call returned.
	//
	// `review-pending` is latched on the settled round alone, so it is true whether
	// or not the review tool has been called; the test asserts the *decision* is
	// absent after the reopen, which is what makes it a kill before the commit.
	"review-pending": (state) => state.awaitingReview,
	"review-accepted": (state) => state.reviewAccepted,
	"rework-decided": (state) => state.reviewRejected && !state.roundAdvanced,
	"rework-settled": (state) => state.reworkSettled,
};

const matches = reached[boundary];
if (matches === undefined) throw new Error(`batch-watch: unknown boundary ${String(boundary)}`);

let database;
const statements = new Map();

/** Open lazily: the runner starts this thread after the schema exists, but a poll may race the first file creation. */
function open() {
	if (database !== undefined) return database;
	// Read-only: this thread must never write the file the runner is writing, and a
	// read transaction is enough to get one consistent WAL snapshot per poll.
	database = new DatabaseSync(dbPath, { readOnly: true });
	return database;
}

/** `prepare()` compiles the SQL, which costs more than the lookup; the loop reuses the same handful of statements. */
function statement(connection, sql) {
	const cache = statements.get(connection) ?? new Map();
	if (!statements.has(connection)) statements.set(connection, cache);
	let prepared = cache.get(sql);
	if (prepared === undefined) {
		prepared = connection.prepare(sql);
		cache.set(sql, prepared);
	}
	return prepared;
}

// Facts that only ever move one way are latched the first time they are true,
// so a poll after the child exists does not ask whether it exists.
let childSeen = false;
let submittedSeen = false;
let answeredSeen = false;
let resultSeen = false;

// Document ids are stable for the life of a run, so the kind+key lookup runs
// at most once per document.
const documentIds = new Map();
// The ledger is the only document that has to be materialised; it is redone
// only when its newest revision number moves.
let ledgerCache = { id: "", seq: -1, value: undefined, version: "" };

/**
 * One consistent snapshot per poll.
 *
 * A poll is several statements, and a commit can land between them; WAL gives a
 * read transaction a snapshot, so the flags always describe one moment. This
 * matters most for the pair that is written in different commits — a torn read
 * could otherwise report a claim that was already settled.
 */
function snapshot() {
	const connection = open();
	connection.exec("BEGIN");
	try {
		const value = ledgerValue(connection);
		const status = submittedStatus(connection);
		const result = resultExists(connection);
		// Each flag is this poll's truth (latched or freshly read), never merely the
		// previous poll's answer: a flag that lags by one poll would report a round
		// as unsubmitted after its submission had already committed.
		const review = value?.reviews?.at(-1);
		const rounds = value?.rounds ?? [];
		const state = {
			claim: value !== undefined && value.activeOpKey !== undefined,
			child: childSeen || childExists(connection),
			submitted: submittedSeen || status !== undefined,
			answered: answeredSeen || status === "done",
			result: resultSeen || result,
			retryWait: rounds.find((entry) => entry.round === round)?.execution?.status === "retry_wait",
			// The decision is a delta on the ledger, so its own review list is the
			// cheapest true signal; the status and the round list say what followed it.
			awaitingReview:
				value?.status === "awaiting_review" &&
				(value?.reviews ?? []).length === 0 &&
				rounds.some((entry) => entry.round === round && entry.execution?.status === "completed"),
			reviewAccepted: value?.status === "accepted" && review?.decision === "accept",
			reviewRejected: review?.decision === "reject",
			roundAdvanced: rounds.some((entry) => entry.round > round),
			reworkSettled:
				review?.decision === "reject" &&
				rounds.some((entry) => entry.round > round && entry.execution?.status === "completed"),
		};
		connection.exec("COMMIT");
		if (state.child) childSeen = true;
		if (state.submitted) submittedSeen = true;
		if (state.answered) answeredSeen = true;
		if (state.result) resultSeen = true;
		return state;
	} catch (error) {
		try {
			connection.exec("ROLLBACK");
		} catch {
			// The failing statement may already have ended the transaction.
		}
		throw error;
	}
}

/** The task ledger's current value, advanced by whatever revisions landed since the last poll. */
function ledgerValue(connection) {
	const id = documentId(connection, LEDGER_KIND, LEDGER_KEY);
	if (id === undefined) return undefined;
	const seq = statement(connection, SQL.maxSeq).get(id)?.seq ?? 0;
	if (ledgerCache.id === id) {
		if (ledgerCache.seq === seq) return ledgerCache.value;
		// A delta is an update, not a rewrite, so the one or two revisions that
		// landed since the last poll are applied to the cached value. Replaying the
		// document from its base on every poll would spend most of the window on
		// history that did not change — and this window is a few commits wide.
		if (ledgerCache.value !== undefined) {
			let value = ledgerCache.value;
			for (const revision of statement(connection, SQL.tail).all(id, ledgerCache.seq)) {
				if (revision.kind !== "delta" || revision.version !== ledgerCache.version) {
					value = undefined;
					break;
				}
				value = apply(value, JSON.parse(revision.content));
			}
			if (value !== undefined) {
				ledgerCache = { id, seq, value, version: ledgerCache.version };
				return value;
			}
		}
	}
	const base = statement(connection, SQL.base).get(id);
	if (base === undefined) {
		// A row with no base revision means the document was replaced under the
		// cached id; forget it and resolve again on the next poll.
		documentIds.delete(cacheKey(LEDGER_KIND, LEDGER_KEY));
		return undefined;
	}
	let value = JSON.parse(base.content);
	for (const revision of statement(connection, SQL.tail).all(id, base.seq)) {
		if (revision.kind !== "delta" || revision.version !== base.version) {
			ledgerCache = { id: "", seq: -1, value: undefined, version: "" };
			return undefined;
		}
		value = apply(value, JSON.parse(revision.content));
	}
	ledgerCache = { id, seq, value, version: base.version };
	return value;
}

function cacheKey(kind, key) {
	return `${kind}\u0000${key}`;
}

function documentId(connection, kind, key) {
	const cached = documentIds.get(cacheKey(kind, key));
	if (cached !== undefined) return cached;
	const row = statement(connection, SQL.document).get(kind, key);
	if (row === undefined) return undefined;
	documentIds.set(cacheKey(kind, key), row.id);
	return row.id;
}

function childExists(connection) {
	return statement(connection, SQL.child).get() !== undefined;
}

/** `undefined` until the round's submission exists; after that the status moves forward and is read until it cannot. */
function submittedStatus(connection) {
	if (answeredSeen) return "done";
	const row = statement(connection, SQL.submission).get(ROUND_REQUEST);
	return row === undefined ? undefined : row.status;
}

function resultExists(connection) {
	if (resultSeen) return true;
	// The result document is created in the commit that writes the receipt, so
	// the document row *is* the persisted result.
	return documentId(connection, RESULT_KIND, RESULT_KEY) !== undefined;
}

let announced = false;
let stopped = false;
let ready = false;

// Opened before the run, appended to at the kill: the file exists from the
// start and is empty until a boundary is actually seen, so its *content* is the
// proof and its mere existence is not.
const markerFd = openSync(markerPath, "a");

function tick() {
	const state = snapshot();
	// The first successful read is the handshake: a runner that started the batch
	// before this thread could see the file would race its own first boundary.
	if (!ready) {
		ready = true;
		parentPort?.postMessage({ ready: true });
	}
	if (!matches(state)) return;
	if (announced) return;
	announced = true;
	stopped = true;
	// The kill comes as close to the observation as a syscall allows. The marker
	// proves *which* state was seen, and a marker without a dead process would be a
	// lie about the order, so it is written first — but through a descriptor opened
	// before the run: `writeFileSync` would reopen the file here, and a few hundred
	// microseconds is most of the width the narrowest boundary has.
	writeSync(markerFd, `${boundary}\n`);
	process.kill(pid, "SIGKILL");
}

/**
 * Busy poll, deliberately.
 *
 * A `setImmediate` turn between polls costs about a millisecond on Windows, and
 * two of the four boundaries are only a couple of commits wide — a loop that
 * sleeps, even for zero milliseconds, can miss the state it exists to catch.
 * This thread has no other job, and the process it watches is killed as soon as
 * the state is seen, so spinning is the honest trade.
 */
function loop() {
	while (!stopped) {
		try {
			tick();
		} catch {
			// A migration or a checkpoint can briefly lock the file, and the schema may
			// not exist for the first few polls. The next tick reads it again.
		}
	}
}

loop();
