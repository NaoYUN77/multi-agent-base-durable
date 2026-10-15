// TASK-005.2 src/service/main-service.ts
//
// The shared Main service: one long-lived conversation the TUI and the headless
// entry point both drive. It owns the request lifecycle, the write boundaries
// for answers, and the promise that a control call never waits behind a long
// model wait.
//
// Shape of a request:
//
//   submitUserInput   records the request (first input) or the answer to an open
//                     question (a later input), then submits it into the *same*
//                     conversation and returns the submission handle.
//   readRequest       reads back the persisted request, its questions and its
//                     plans. Read-only; never blocks.
//   status            the conversation's live status, read without waiting.
//   requestCancel     persists a cancel intent, then aborts. Signals only.
//   close             closes the Harness cleanly.
//
// Three rules this file makes mechanical, all from the contract:
//
//   1. **The application records the answer, the model does not.** An answer goes
//      through `composeUserAnswer`, which stamps `source: "application"`; the
//      payload has nowhere to claim it, and a later model turn cannot rewrite it.
//   2. **A control call does not queue behind a model wait.** `status()` and
//      `requestCancel()` read or write documents directly and never await a
//      submission, so a long round cannot make the service unresponsive (AC-05).
//   3. **A busy ordinary input is queued, not silently reinterpreted.** The
//      outcome says which of the three things happened.

import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	Harness,
	Registry,
	Submission,
	Tx,
} from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc } from "../agent/contracts/documents.ts";
import { composeUserAnswer, openQuestionIds, type ClarificationState, type UserAnswer } from "../agent/contracts/clarification.ts";
import { validatePlan, type Plan } from "../agent/contracts/plan.ts";
import { MainServiceDoc, type OperationReceipt, type PlanIndexEntry, type QueuedInput } from "../agent/main/service-doc.ts";
import { answerInputId, queuedInputId, requestInputId } from "../agent/main/request-id.ts";
import { createMainExtension, type MainToolHost } from "../agent/main/tools.ts";
import { mainInstructions } from "../agent/prompts/main.ts";

/** Everything the service needs from its host, injected so tests can drive it. */
export type MainServiceOptions = {
	readonly harness: Harness;
	/**
	 * The run's registry. Required, and not optional: an extension a conversation
	 * selects must first be *installed* here, so a service without one would
	 * configure an agent whose tools cannot resolve.
	 */
	readonly registry: Registry;
	readonly context: Context;
	/** The Main conversation, from `harness.root`. */
	readonly conversationId: ConversationId;
	/** Executor for admitted dispatch batches. Required: the service never invents one. */
	readonly dispatch: MainToolHost["dispatch"];
	/** Dependencies not yet accepted, when the executor can report them. */
	readonly unacceptedDependencies?: MainToolHost["unacceptedDependencies"];
	/** Clock, so a test can make timestamps deterministic. Defaults to `Date.now`. */
	readonly now?: () => number;
	/**
	 * Extra instructions appended after the bundled Main prompt. The prompt the
	 * agent actually receives is `mainInstructions(extra)`; a test reads it back
	 * from the conversation rather than asserting a string was built.
	 */
	readonly instructionsExtra?: string;
};

/** What one `submitUserInput` call did. */
export type SubmitOutcome =
	/** Admitted as the start (or restatement) of a request. */
	| { readonly kind: "request"; readonly requestId: string; readonly requestVersion: number; readonly submission: Submission }
	/** Answered an open question; the answer was recorded before the submission. */
	| { readonly kind: "answer"; readonly questionId: string; readonly submission: Submission }
	/** Arrived while a round was running, so the Harness queued it for the next boundary. */
	| { readonly kind: "queued"; readonly submission: Submission; readonly reason: string }
	/** Could not be admitted; nothing was submitted. */
	| { readonly kind: "refused"; readonly reason: string };

/** A read-only view of the active request. Never blocks on the model. */
export type RequestView = {
	readonly requestId: string | undefined;
	readonly requestVersion: number;
	readonly text: string;
	readonly openQuestionIds: readonly string[];
	readonly questions: ClarificationState["questions"];
	readonly answers: readonly UserAnswer[];
	readonly plans: readonly Plan[];
};

/** The service's control surface, readable while a round runs. */
export type MainService = {
	readonly conversationId: ConversationId;
	/**
	 * Record and submit a user input.
	 *
	 * `answerTo` names the question this input answers: the answer is recorded
	 * through the application's write boundary *before* the submission, so what
	 * the model reads is the persisted answer. When `answerTo` is omitted while a
	 * question is open, the input is refused rather than silently reinterpreted as
	 * a new task (AC-04).
	 */
	submitUserInput(input: {
		readonly text: string;
		readonly requestId?: string;
		readonly answerTo?: string;
		/**
		 * The application's judgement of an answer, not the model's, and **required
		 * when `answerTo` is given**. There is no default: "the user replied" is not
		 * "the reply is sufficient" (contract §"Main Agent 合同"), so an input that
		 * answers without a judgement is refused rather than treated as settled.
		 * `false` leaves the question open for the model to ask again.
		 */
		readonly sufficient?: boolean;
		readonly expectedRequestVersion?: number;
	}): Promise<SubmitOutcome>;
	/** Read the active request, its open questions and its plans. Read-only; never waits on a model. */
	readRequest(): Promise<RequestView>;
	/** Inputs admitted while the conversation was busy and not yet submitted. */
	readQueue(): Promise<readonly QueuedInput[]>;
	/**
	 * Withdraw one queued input. Only that input is withdrawn — the rest of the
	 * queue and any running round are untouched.
	 */
	withdrawQueued(submissionId: string): Promise<{ readonly withdrawn: boolean; readonly reason: string }>;
	/** The conversation's live status, read from `harness.inspect()`. Writes nothing. */
	status(): Promise<{ readonly busy: boolean; readonly openQuestionIds: readonly string[]; readonly requestId: string | undefined }>;
	/**
	 * Persist a cancellation intent, then abort the conversation's ordinary
	 * ownership scope. Returns once the abort is signalled; it does not wait for a
	 * model round to finish, which is the point of a control call.
	 */
	requestCancel(reason?: string): Promise<{ readonly requested: boolean; readonly reason: string }>;
	close(): Promise<void>;
};

/** Open the Main service over an existing conversation. */
export async function openMainService(options: MainServiceOptions): Promise<MainService> {
	const { harness, context, conversationId } = options;
	const now = options.now ?? Date.now;
	const found: Conversation | undefined = await harness.conversation(conversationId, context);
	if (found === undefined) throw new Error(`main service: conversation ${String(conversationId)} not found`);
	// Bound after the check, so the closures below carry a non-optional handle.
	const handle: Conversation = found;

	/**
	 * Committed reads go through `handle.commit` rather than `harness.snapshot`.
	 *
	 * The reason is the contract's own: the service must read the *latest*
	 * persisted value. `snapshot` is a read-only viewer, and the locked Harness
	 * notes that read-only viewers never enable scheduling, so a service built on
	 * them would silently not drive the work it is supposed to serve. A commit
	 * gives the same committed read while keeping the conversation live.
	 */
	async function activeRequest(tx?: Tx): Promise<{ readonly requestId: string; readonly requestVersion: number } | undefined> {
		// `tx` when the caller is already inside a transaction: a tool's admission
		// must read the pointer in *its own* transaction, or it compares a plan
		// against a value that may already have moved by the time it commits.
		const read = async (tx: Tx) => {
			const doc = await tx.doc(MainServiceDoc, conversationId);
			// The requirement a run serves is the one its *own* inputs were admitted
			// for — not the mutable pointer. The pointer is written when a restatement
			// is consumed, which happens after the Harness has already placed the
			// input and started the run; resolving from the pointer alone therefore
			// lets a run write plans and dispatch under the previous requirement's
			// identity. The run's inputs are known before any tool in it executes.
			const live = await tx.doc(LiveDoc, conversationId);
			const running = live.run?.inputs ?? [];
			for (let index = running.length - 1; index >= 0; index--) {
				const admission = doc.admissions.find((entry) => entry.submissionId === String(running[index]));
				if (admission === undefined) continue;
				// A rejected input (its version basis went stale while it waited) has no
				// requirement: the run must refuse, not fall through to the previous
				// request and act under its identity.
				if (admission.rejected === true) return undefined;
				// The basis is re-checked here, at the moment the run resolves its
				// requirement — not only on a later queue read, which is after the run
				// may already have written a plan or dispatched.
				if (admission.expectedRequestVersion !== undefined) {
					const request = await tx.doc(AgentRequestDoc, conversationId, admission.requestId, { requestId: admission.requestId });
					const storedVersion = request.requestedAt === 0 ? undefined : request.requestVersion;
					if (storedVersion !== undefined && storedVersion !== admission.expectedRequestVersion) return undefined;
				}
				return { requestId: admission.requestId, requestVersion: admission.requestVersion };
			}
			// Nothing running was admitted by this service. Fall back to the pointer
			// rather than inventing a requirement.
			return doc.activeRequestId === undefined ? undefined : { requestId: doc.activeRequestId, requestVersion: doc.requestVersion };
		};
		return tx === undefined ? await handle.commit(read, context) : await read(tx);
	}

	/** Record the requirement identity of one admitted input, so its run can resolve it. */
	async function recordAdmission(
		tx: Tx,
		submissionId: string,
		requestId: string,
		requestVersion: number,
		expectedRequestVersion?: number,
	): Promise<void> {
		const doc = await tx.doc(MainServiceDoc, conversationId);
		// One entry per submission: a replay of the same admission is the same fact.
		if (doc.admissions.some((entry) => entry.submissionId === submissionId)) return;
		doc.admissions = [
			...doc.admissions,
			{ submissionId, requestId, requestVersion, ...(expectedRequestVersion === undefined ? {} : { expectedRequestVersion }) },
		];
	}

	async function readClarificationIn(tx: Tx, requestId: string): Promise<ClarificationState> {
		const state = await tx.doc(AgentClarificationDoc, conversationId, requestId, { requestId });
		// A deep copy, not a shallow one: the document's nested values are
		// write overlays that are only readable inside this commit, so a
		// spread of the arrays would hand the caller objects that throw
		// "Cannot use a settled overlay" the moment they are touched.
		return JSON.parse(
			JSON.stringify({
				schemaVersion: state.schemaVersion,
				questions: state.questions,
				answers: state.answers,
				resolutions: state.resolutions,
			}),
		) as ClarificationState;
	}

	async function readClarification(requestId: string): Promise<ClarificationState> {
		return await handle.commit(async (tx) => await readClarificationIn(tx, requestId), context);
	}

	/** The plans of one request, read from the persisted index and the plan documents. */
	async function readPlansOf(requestId: string): Promise<readonly Plan[]> {
		const index = await handle.commit(async (tx) => {
			const doc = await tx.doc(MainServiceDoc, conversationId);
			return (JSON.parse(JSON.stringify(doc.plans)) as PlanIndexEntry[]).filter((entry) => entry.requestId === requestId);
		}, context);
		const plans: Plan[] = [];
		for (const entry of index) {
			// The copy has to happen inside the commit: the document's nested values
			// are write overlays that throw "Cannot use a settled overlay" once the
			// commit is finished.
			const raw = await handle.commit(
				async (tx) => JSON.parse(JSON.stringify(await tx.doc(AgentPlanDoc, conversationId, entry.planId, { planId: entry.planId }))),
				context,
			);
			if (raw.version === 0) continue;
			const checked = validatePlan(raw);
			// The index says which request a plan was saved for, but the document is
			// keyed by `planId` alone — so a later request that reused the id owns the
			// document now, and the index entry is the *old* claim. Returning the
			// document on the index's word alone would hand request A a plan whose
			// goals and tasks belong to request B. The document is the authority.
			if (checked.ok && checked.value.requestId === requestId) plans.push(checked.value);
		}
		return plans;
	}

	/**
	 * Mark one management-tool call as begun, before it runs its side effect. A
	 * crash between this and `recordOperation` leaves a start with no result, which
	 * a replay reports as interrupted instead of re-executing.
	 */
	async function beginOperation(opKey: string): Promise<void> {
		await handle.commit(async (tx) => {
			const doc = await tx.doc(MainServiceDoc, conversationId);
			if (doc.receipts.some((receipt) => receipt.opKey === opKey)) return;
			doc.receipts = [...doc.receipts, { opKey, at: now() }];
		}, context);
	}

	/**
	 * Record one finished management-tool call, so a replay returns its result
	 * instead of redoing the work. `replay: "safe"` is not exactly-once.
	 *
	 * When `tx` is given the receipt is written in the caller's transaction, so the
	 * business change and the result that describes it commit together. That is what
	 * closes the window a second transaction leaves: a crash between the two would
	 * otherwise replay a committed question as a duplicate, or a committed save as a
	 * stale-version refusal.
	 */
	async function recordOperation(
		input: {
			readonly opKey: string;
			readonly result: string;
			readonly isError?: boolean;
			readonly control?: { readonly handoff?: string };
		},
		tx?: Tx,
	): Promise<void> {
		const write = async (tx: Tx) => {
			const doc = await tx.doc(MainServiceDoc, conversationId);
			const existing = doc.receipts.find((receipt) => receipt.opKey === input.opKey);
			// A finished call is never overwritten by a replay: the first result stands.
			if (existing?.result !== undefined) return;
			const receipt: OperationReceipt = { opKey: input.opKey, result: input.result, at: now() };
			if (input.isError !== undefined) (receipt as { isError?: boolean }).isError = input.isError;
			if (input.control !== undefined) (receipt as { control?: { readonly handoff?: string } }).control = input.control;
			// A begin-then-finish replaces the started marker in place, so a call has
			// exactly one receipt whatever path it took.
			doc.receipts =
				existing === undefined
					? [...doc.receipts, receipt]
					: doc.receipts.map((entry) => (entry.opKey === input.opKey ? receipt : entry));
		};
		if (tx === undefined) await handle.commit(write, context);
		else await write(tx);
	}

	async function readOperation(
		opKey: string,
	): Promise<{ readonly result?: string; readonly isError?: boolean; readonly control?: { readonly handoff?: string } } | undefined> {
		return await handle.commit(async (tx) => {
			const doc = await tx.doc(MainServiceDoc, conversationId);
			const found = doc.receipts.find((receipt) => receipt.opKey === opKey);
			// Copied inside the commit: the document's nested values are write overlays
			// that throw "Cannot use a settled overlay" once it finishes.
			return found === undefined
				? undefined
				: (JSON.parse(JSON.stringify({ result: found.result, isError: found.isError, control: found.control })) as {
						readonly result?: string;
						readonly isError?: boolean;
						readonly control?: { readonly handoff?: string };
					});
		}, context);
	}

	/**
	 * The text a clarification hands back to the next round.
	 *
	 * The program assembles it from persisted facts, never from the model. A
	 * handoff *replaces* the model's context, so anything this omits is context
	 * the next round cannot see: the request as the user stated it, its materials,
	 * the answer that was just recorded, and the open questions. This is what makes
	 * the guaranteed round end compatible with a long-lived Main conversation —
	 * the model's automatic history is reset, the *facts* are not.
	 */
	async function buildHandoff(
		input: {
			readonly requestId: string;
			readonly questionId: string;
			readonly question: string;
			readonly reason: string;
		},
		tx?: Tx,
	): Promise<string> {
		// Copied inside the commit, because the document's nested values are write
		// overlays that throw "Cannot use a settled overlay" once it finishes.
		const readRequest = async (tx: Tx) => {
			const doc = await tx.doc(AgentRequestDoc, conversationId, input.requestId, { requestId: input.requestId });
			return JSON.parse(JSON.stringify({ requestVersion: doc.requestVersion, text: doc.text, materials: doc.materials })) as {
				readonly requestVersion: number;
				readonly text: string;
				readonly materials: readonly { readonly source: string; readonly content: string }[];
			};
		};
		const request = tx === undefined ? await handle.commit(readRequest, context) : await readRequest(tx);
		const clarification = tx === undefined ? await readClarification(input.requestId) : await readClarificationIn(tx, input.requestId);
		const answer = clarification.answers.find((entry) => entry.questionId === input.questionId);
		const open = openQuestionIds(clarification).filter((id) => id !== input.questionId);
		const lines = [
			`Request ${input.requestId} v${request.requestVersion}: ${request.text}`,
			request.materials.length === 0
				? "Materials: (none recorded)"
				: `Materials:\n${request.materials.map((material) => `- [${material.source}] ${material.content}`).join("\n")}`,
			`You asked: ${input.question}`,
			`Why: ${input.reason}`,
			answer === undefined
				? "The user has not answered yet. Wait for their reply; do not invent one."
				: `The user answered: ${answer.text}${answer.sufficient ? "" : " (The application did not judge this sufficient.)"}`,
			open.length === 0 ? "No other question is open." : `Still open: ${open.join(", ")}`,
		];
		return lines.join("\n");
	}

	/**
	 * Install the Main agent: the bundled prompt plus the three management tools.
	 *
	 * Two steps, and both are required. `registry.install` makes the extension's
	 * tools resolvable at all; `configure` then *selects* it for this conversation
	 * and replaces the tool set rather than adding to it, so the agent sees exactly
	 * `request_clarification`, `save_plan` and `dispatch_tasks` — not the TASK-003
	 * delegation tools, which belong to a later Issue's runtime. An extension that
	 * is selected but not installed resolves to nothing, which is why the registry
	 * is a required option rather than something this module reaches for.
	 *
	 * `activeRequest` is a closure, not a captured value: a tool call reads the
	 * pointer as it stands at that moment, so a question asked after a restatement
	 * binds to the current request.
	 */
	const extension = createMainExtension({
		activeRequest,
		dispatch: options.dispatch,
		now,
		buildHandoff,
		readOperation,
		beginOperation: (input) => beginOperation(input.opKey),
		recordOperation,
		// `save_plan` writes its own index entry inside its transaction, so the index
		// and the plan can never disagree — and because the index is *persisted*, the
		// plan list survives a reopen instead of belonging to the process that saved
		// it.
		indexPlans: true,
		...(options.unacceptedDependencies === undefined ? {} : { unacceptedDependencies: options.unacceptedDependencies }),
	});
	options.registry.install(extension);
	await handle.configure({ extensions: [extension], instructions: mainInstructions(options.instructionsExtra) }, context);

	/**
	 * Whether this conversation has live non-background work.
	 *
	 * Read from `inspect()` rather than by racing `waitForIdle`: a control call
	 * must not be made to wait on the very round it is asking about (AC-05).
	 */
	async function busy(): Promise<boolean> {
		const inspection = await harness.inspect(context);
		// `inspect()` lists only live tasks and unsettled submissions, so every
		// entry is non-terminal by construction; filtering by conversation and by
		// background is what this needs.
		return inspection.tasks.some((task) => task.record.conversationId === conversationId && task.record.background !== true);
	}

	/**
	 * The consume boundary for the queue.
	 *
	 * A queued input is placed into the transcript by the Harness when the round it
	 * was waiting on reaches its boundary — that is not something this service
	 * drives. So the persisted queue is reconciled against what the Harness
	 * actually holds before it is reported: an input the Harness no longer lists as
	 * `queued` has been placed (or settled), and its record is removed. Without
	 * this the queue only ever grew, and a caller could withdraw an input that had
	 * already been consumed.
	 *
	 * Removing the record is not the whole job. A queued restatement carries *its
	 * own* requirement identity, and the service's active pointer still names
	 * whatever was being served when the round began. Consuming the input therefore
	 * also applies that identity to the request document and the pointer — in the
	 * same commit — and re-checks the version basis the caller gave: a restatement
	 * whose `expectedRequestVersion` went stale while it waited is dropped rather
	 * than applied as if it were current. "Left the queue" and "became the active
	 * requirement" are different facts, and only the second one is correctness.
	 */
	async function reconcileQueue(): Promise<void> {
		const held = await handle.commit(async (tx) => {
			const doc = await tx.doc(MainServiceDoc, conversationId);
			return JSON.parse(JSON.stringify(doc.queue)) as QueuedInput[];
		}, context);
		if (held.length === 0) return;
		const inspection = await harness.inspect(context);
		const stillQueued = new Set(
			inspection.submissions
				.filter((record) => record.conversationId === conversationId && record.type === "input" && record.status === "queued")
				.map((record) => String(record.id)),
		);
		const consumed = held.filter((entry) => !stillQueued.has(String(entry.submissionId)));
		if (consumed.length === 0) return;
		await handle.commit(async (tx) => {
			const doc = await tx.doc(MainServiceDoc, conversationId);
			// Apply each consumed input's requirement identity, oldest first, so the
			// pointer ends at the newest restatement the round's boundary admitted.
			for (const entry of consumed) {
				const request = await tx.doc(AgentRequestDoc, conversationId, entry.requestId, { requestId: entry.requestId });
				const storedVersion = request.requestedAt === 0 ? undefined : request.requestVersion;
				// The caller's basis must still hold. A stale one is not applied — the
				// input was admitted, but it does not become the active requirement.
				if (entry.expectedRequestVersion !== undefined && storedVersion !== undefined && storedVersion !== entry.expectedRequestVersion) {
					// It cannot be un-placed from the transcript, but it is denied an
					// identity: a run made of it resolves no requirement and its tools
					// refuse, rather than acting under the previous request.
					doc.admissions = doc.admissions.map((admission) =>
						admission.submissionId === entry.submissionId ? { ...admission, rejected: true } : admission,
					);
					continue;
				}
				// The version was allocated when the input was admitted, not here: the
				// run made of this input already resolved it, and a version derived now
				// would land *after* that run saved its plans — invalidating them. The
				// document is written to the allocated version so the requirement, the
				// pointer and the run's own admission all agree.
				//
				// `Math.max` with the stored version keeps the requirement monotonic if
				// reconciliation ever lands out of order: the version must not move
				// *backwards*, because a plan already bound to a higher version would then
				// mismatch the requirement that owns it.
				const nextVersion = storedVersion === undefined ? entry.allocatedVersion : Math.max(storedVersion, entry.allocatedVersion);
				request.requestVersion = nextVersion;
				request.text = entry.text;
				request.requestedAt = entry.queuedAt;
				doc.activeRequestId = entry.requestId;
				doc.requestVersion = nextVersion;
				// The admission already names the allocated version (it was recorded that
				// way at admission time), so there is nothing to rewrite here. Rewriting it
				// from a value derived at consume time is what made the run's own plans
				// mismatch the request document.
			}
			doc.queue = doc.queue.filter((entry) => !consumed.some((gone) => gone.submissionId === entry.submissionId));
		}, context);
	}

	const service: MainService = {
		conversationId,

		async submitUserInput(input) {
			const text = input.text;
			if (text.trim() === "") return { kind: "refused", reason: "empty input" };

			const current = await activeRequest();
			const openIds = current === undefined ? [] : openQuestionIds(await readClarification(current.requestId));

			// ── Answering an open question ────────────────────────────────────────
			if (input.answerTo !== undefined) {
				if (current === undefined) return { kind: "refused", reason: "no active request to answer" };
				if (!openIds.includes(input.answerTo)) return { kind: "refused", reason: `question ${input.answerTo} is not open` };
				// The write boundary: `source` is stamped by the composer, and the
				// payload below has no field to claim it. There is no default for
				// `sufficient`: omitting it means the application has NOT judged the
				// answer, which keeps the question open. "The user replied" is not
				// "the reply was sufficient" (contract §"Main Agent 合同").
				const sufficient = input.sufficient;
				if (sufficient === undefined) {
					return {
						kind: "refused",
						reason: `answer needs a sufficiency judgement: pass sufficient: true or false for question ${input.answerTo}`,
					};
				}
				const composed = composeUserAnswer({ questionId: input.answerTo, text, sufficient }, { at: now() });
				if (!composed.ok) {
					return { kind: "refused", reason: `answer refused: ${composed.violations.map((v) => `${v.path}:${v.code}`).join(", ")}` };
				}
				// The answer AND its resolution are written in one commit, and both are
				// required: a question stops blocking on a *resolution*, not on an
				// answer. The clarification contract holds exactly one answer per
				// question, so a follow-up reply REPLACES the stored answer rather than
				// appending a second one (a duplicate is a validation failure), and the
				// replaced text is kept in the service's own attempt log so the
				// exchange stays auditable.
				//
				// The returned revision counts the *attempts*, not the stored answers:
				// it is what makes a follow-up a new submission rather than a replay of
				// the first answer, and it must therefore increase even though the
				// stored answer count does not.
				const revision = await handle.commit(async (tx) => {
					const service = await tx.doc(MainServiceDoc, conversationId);
					const state = await tx.doc(AgentClarificationDoc, conversationId, current.requestId, { requestId: current.requestId });
					const previous = state.answers.find((entry) => entry.questionId === input.answerTo);
					if (previous !== undefined) state.answers = state.answers.filter((entry) => entry.questionId !== input.answerTo);
					const answer = composed.value;
					state.answers = [...state.answers, answer];
					// A repeat of the *same logical answer* — the same words, judged the
					// same way — is a replay, not a new input: it reuses the attempt it
					// already has, so the submission key is unchanged and the Harness
					// deduplicates it. Only a genuinely different reply (different words, or
					// the same words judged differently) is a new attempt and a new key.
					//
					// Every distinct answer is recorded as an attempt, whichever way the
					// judgement went: the clarification document holds exactly one answer
					// per question, so an earlier reply is otherwise gone, and the attempt
					// log is what keeps the exchange auditable.
					const same = service.answerAttempts.find(
						(attempt) => attempt.questionId === input.answerTo && attempt.text === text && attempt.sufficient === sufficient,
					);
					if (same === undefined) {
						service.answerAttempts = [...service.answerAttempts, { questionId: input.answerTo!, text, sufficient, at: answer.answeredAt }];
					}
					// Only a sufficient answer resolves the question. An insufficient one
					// leaves it open, and the model is expected to ask again.
					if (sufficient) {
						state.resolutions = [
							...state.resolutions.filter((entry) => entry.questionId !== input.answerTo),
							{ questionId: input.answerTo!, resolvedAt: answer.answeredAt, resolvedBy: "application", basis: { kind: "answer", answerAt: answer.answeredAt } },
						];
					}
					// The revision is the ordinal of this logical answer among the
					// question's attempts, so a replay of an earlier answer returns the
					// revision it had — and a new one gets a new key.
					return service.answerAttempts.filter((attempt) => attempt.questionId === input.answerTo).findIndex(
						(attempt) => attempt.text === text && attempt.sufficient === sufficient,
					) + 1;
				}, context);
				// The submission key carries the request AND the revision, so a
				// follow-up to the same question is its own input rather than a replay
				// of the first answer — and two requests that ask the same words cannot
				// collide on one key.
				const submission = await handle.submit(
					{ type: "input", content: text, requestId: answerInputId(current.requestId, input.answerTo, revision) },
					context,
				);
				await handle.commit(
					async (tx) => await recordAdmission(tx, String(submission.id), current.requestId, current.requestVersion),
					context,
				);
				return { kind: "answer", questionId: input.answerTo, submission };
			}

			// ── A plain input while a question is open ────────────────────────────
			// Refused rather than silently treated as a new task: the contract
			// forbids the silent reinterpretation, and the caller can answer
			// explicitly with `answerTo`.
			if (openIds.length > 0) {
				return { kind: "refused", reason: `question ${openIds[0]} is open; answer it with answerTo` };
			}

			// ── A plain input while a round is running ────────────────────────────
			// Queued, not submitted, and not keyed on the text: two different
			// requests that say the same words are two inputs, and keying on the text
			// would collapse them into one and drop the second. The queue is a
			// persisted record, so it can be queried and withdrawn.
			if (await busy()) {
				const requestId = input.requestId ?? current?.requestId ?? `req-${now().toString(36)}`;
				const requestVersion = current?.requestVersion ?? 1;
				const queuedAt = now();
				// The version this input *becomes*, allocated here rather than at the
				// consume boundary. The Harness places a queued input and starts its run
				// at the round boundary — before any service call reads the queue — so a
				// version derived at consume time arrives after that run has already
				// resolved its requirement. Allocating it now is what lets the run bind
				// its plans, and admit its dispatch, against the version the requirement
				// is actually at.
				const allocatedVersion = await handle.commit(async (tx) => {
					const doc = await tx.doc(MainServiceDoc, conversationId);
					// The allocation is per requirement: a queued input becomes the version
					// after the one the requirement is at, and a second queued input for the
					// same requirement takes the version after that. Every input is decided
					// from persisted state, so the same admission allocates the same version
					// on a retry.
					//
					// The *request document* is the authority for the version, not the
					// pointer: the pointer is only moved when an input is consumed, so it
					// lags, and the request document is what a plan is compared against.
					// `requestedAt === 0` is the contract's "nothing recorded yet", so a
					// request that has never been written starts at 1 like any other.
					const request = await tx.doc(AgentRequestDoc, conversationId, requestId, { requestId });
					const stored = request.requestedAt === 0 ? undefined : request.requestVersion;
					const alreadyAllocated = doc.queue.filter((entry) => entry.requestId === requestId).map((entry) => entry.allocatedVersion);
					const highest = Math.max(stored ?? 0, ...alreadyAllocated);
					return highest === 0 ? 1 : highest + 1;
				}, context);
				// The submission key is the logical identity of the input, not a clock:
				// keying on `queuedAt` would make the same input a different submission on
				// a retry, which is the replay the dedup key exists to catch. The version
				// in the key stays the version the input was queued *against* — the
				// requirement's version when the caller submitted — because that is the
				// identity the caller's own decision was made against.
				const submission = await handle.submit(
					{ type: "input", content: text, requestId: queuedInputId(requestId, requestVersion, text) },
					context,
				);
				const record: QueuedInput = {
					submissionId: String(submission.id),
					requestId,
					requestVersion,
					allocatedVersion,
					...(input.expectedRequestVersion === undefined ? {} : { expectedRequestVersion: input.expectedRequestVersion }),
					text,
					queuedAt,
				};
				await handle.commit(async (tx) => {
					const doc = await tx.doc(MainServiceDoc, conversationId);
					doc.queue = [...doc.queue, record];
					// The admission is recorded now, so that when the Harness places this
					// input at the next boundary and starts a run for it, the run resolves
					// the requirement from its own input rather than from the lagging
					// pointer — and resolves the version it was allocated, not the one it
					// was queued against.
					await recordAdmission(tx, String(submission.id), requestId, allocatedVersion, input.expectedRequestVersion);
				}, context);
				return { kind: "queued", submission, reason: "a round is running; the input is queued for the next boundary" };
			}

			// ── A new request (or a restatement of the current one) ───────────────
			const requestId = input.requestId ?? current?.requestId ?? `req-${now().toString(36)}`;
			// The version check and the write happen in ONE commit, so a concurrent
			// restatement cannot slip between them.
			let staleVersion: { readonly expected: number; readonly stored: number } | undefined;
			let requestVersion = 0;
			await handle.commit(async (tx) => {
				const doc = await tx.doc(AgentRequestDoc, conversationId, requestId, { requestId });
				const storedVersion = doc.requestedAt === 0 ? undefined : doc.requestVersion;
				if (input.expectedRequestVersion !== undefined && storedVersion !== undefined && storedVersion !== input.expectedRequestVersion) {
					staleVersion = { expected: input.expectedRequestVersion, stored: storedVersion };
					return;
				}
				requestVersion = storedVersion === undefined ? 1 : storedVersion + 1;
				doc.requestVersion = requestVersion;
				doc.text = text;
				doc.requestedAt = now();
				const pointer = await tx.doc(MainServiceDoc, conversationId);
				pointer.activeRequestId = requestId;
				pointer.requestVersion = requestVersion;
			}, context);
			if (staleVersion !== undefined) {
				return { kind: "refused", reason: `stale request version: expected ${staleVersion.expected}, stored ${staleVersion.stored}` };
			}
			const submission = await handle.submit({ type: "input", content: text, requestId: requestInputId(requestId, requestVersion) }, context);
			await handle.commit(async (tx) => await recordAdmission(tx, String(submission.id), requestId, requestVersion), context);
			return { kind: "request", requestId, requestVersion, submission };
		},

		async readRequest() {
			const current = await activeRequest();
			if (current === undefined) {
				return { requestId: undefined, requestVersion: 0, text: "", openQuestionIds: [], questions: [], answers: [], plans: [] };
			}
			const request = await handle.commit(async (tx) => {
				const doc = await tx.doc(AgentRequestDoc, conversationId, current.requestId, { requestId: current.requestId });
				return { requestVersion: doc.requestVersion, text: doc.text };
			}, context);
			const clarification = await readClarification(current.requestId);
			return {
				requestId: current.requestId,
				requestVersion: request.requestVersion,
				text: request.text,
				openQuestionIds: openQuestionIds(clarification),
				questions: clarification.questions,
				answers: clarification.answers,
				// Only this request's plans: an index filtered by the active request,
				// not every plan the conversation has ever held.
				plans: await readPlansOf(current.requestId),
			};
		},

		async status() {
			const current = await activeRequest();
			const clarification = current === undefined ? undefined : await readClarification(current.requestId);
			return {
				busy: await busy(),
				openQuestionIds: clarification === undefined ? [] : openQuestionIds(clarification),
				requestId: current?.requestId,
			};
		},

		/** Inputs admitted while busy and not yet submitted. */
		async readQueue() {
			await reconcileQueue();
			return await handle.commit(async (tx) => {
				const doc = await tx.doc(MainServiceDoc, conversationId);
				// Copied inside the commit: the document's nested values are write
				// overlays that throw "Cannot use a settled overlay" afterwards.
				return JSON.parse(JSON.stringify(doc.queue)) as QueuedInput[];
			}, context);
		},

		/**
		 * Withdraw a queued input that has not been submitted yet.
		 *
		 * The Harness's abort withdraws queued submissions of the whole conversation,
		 * which is exactly what must NOT happen here: withdrawing one queued input
		 * must not disturb the rest. So the intent is recorded first and the
		 * submission is aborted through the public per-submission entry point.
		 */
		async withdrawQueued(submissionId: string) {
			// Reconcile first: an input the Harness has already placed is no longer
			// withdrawable, and reporting it as withdrawn would be a lie.
			await reconcileQueue();
			const found = await handle.commit(async (tx) => {
				const doc = await tx.doc(MainServiceDoc, conversationId);
				return doc.queue.some((entry) => entry.submissionId === submissionId);
			}, context);
			if (!found) return { withdrawn: false, reason: `no queued input ${submissionId}` };
			const outcome = await harness.abortSubmission(submissionId as never, context, conversationId);
			await handle.commit(async (tx) => {
				const doc = await tx.doc(MainServiceDoc, conversationId);
				doc.queue = doc.queue.filter((entry) => entry.submissionId !== submissionId);
			}, context);
			return { withdrawn: outcome === "aborted", reason: outcome };
		},

		async requestCancel(reason) {
			// Documents first, then the abort: the intent is persisted before any
			// signal, so a process that dies mid-cancel leaves a readable intent.
			await handle.commit(async (tx) => {
				const doc = await tx.doc(MainServiceDoc, conversationId);
				doc.cancelRequested = { at: now(), ...(reason === undefined ? {} : { reason }) };
			}, context);
			await handle.abort(context);
			return { requested: true, reason: reason ?? "cancelled_by_user" };
		},

		async close() {
			await harness.close(context);
		},
	};

	return service;
}
