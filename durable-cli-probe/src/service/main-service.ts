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
} from "@earendil-works/pi-durable";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc } from "../agent/contracts/documents.ts";
import { composeUserAnswer, openQuestionIds, type ClarificationState, type UserAnswer } from "../agent/contracts/clarification.ts";
import { validatePlan, type Plan } from "../agent/contracts/plan.ts";
import { MainServiceDoc } from "../agent/main/service-doc.ts";
import { answerInputId, requestInputId, stableSlug } from "../agent/main/request-id.ts";
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
		 * The application's judgement of an answer, not the model's. Defaults to
		 * `true`: the user replied to the question that was asked, so the answer
		 * resolves it. Pass `false` for a reply that does not settle the question,
		 * which leaves it open for the model to ask again.
		 */
		readonly sufficient?: boolean;
		readonly expectedRequestVersion?: number;
	}): Promise<SubmitOutcome>;
	/** Read the active request, its open questions and its plans. Read-only; never waits on a model. */
	readRequest(): Promise<RequestView>;
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
	 * Plan ids this process has seen saved. Plan documents are a family keyed by
	 * planId and the Harness exposes no "list family keys" call, so the service
	 * records the keys it observes. A restart therefore lists no plans until the
	 * model saves or dispatches one again — a limitation recorded in the PR's
	 * "not executed" section rather than papered over with a key scan.
	 */
	const knownPlanIds = new Set<string>();

	/**
	 * Committed reads go through `handle.commit` rather than `harness.snapshot`.
	 *
	 * The reason is the contract's own: the service must read the *latest*
	 * persisted value. `snapshot` is a read-only viewer, and the locked Harness
	 * notes that read-only viewers never enable scheduling, so a service built on
	 * them would silently not drive the work it is supposed to serve. A commit
	 * gives the same committed read while keeping the conversation live.
	 */
	async function activeRequestId(): Promise<string | undefined> {
		return await handle.commit(async (tx) => (await tx.doc(MainServiceDoc, conversationId)).activeRequestId, context);
	}

	async function readClarification(requestId: string): Promise<ClarificationState> {
		return await handle.commit(
			async (tx) => {
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
			},
			context,
		);
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
	 * `activeRequestId` is a closure over the function above, not a captured
	 * value: a tool call reads the pointer as it stands at that moment, so a
	 * question asked after a restatement binds to the current request.
	 */
	const extension = createMainExtension({
		activeRequestId: () => activeRequestId(),
		dispatch: options.dispatch,
		now,
		onPlanSaved: (planId) => knownPlanIds.add(planId),
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

	const service: MainService = {
		conversationId,

		async submitUserInput(input) {
			const text = input.text;
			if (text.trim() === "") return { kind: "refused", reason: "empty input" };

			const current = await activeRequestId();
			const openIds = current === undefined ? [] : openQuestionIds(await readClarification(current));

			// ── Answering an open question ────────────────────────────────────────
			if (input.answerTo !== undefined) {
				if (current === undefined) return { kind: "refused", reason: "no active request to answer" };
				if (!openIds.includes(input.answerTo)) return { kind: "refused", reason: `question ${input.answerTo} is not open` };
				// The write boundary: `source` is stamped by the composer, and the
				// payload below has no field to claim it.
				const composed = composeUserAnswer({ questionId: input.answerTo, text, sufficient: input.sufficient ?? true }, { at: now() });
				if (!composed.ok) {
					return { kind: "refused", reason: `answer refused: ${composed.violations.map((v) => `${v.path}:${v.code}`).join(", ")}` };
				}
				// The answer AND its resolution are written in one commit, and both are
				// required: the contract's rule is that a question stops blocking on a
				// resolution, not on an answer. Receiving an answer is not the same as
				// being satisfied with it, so an answer the application does not judge
				// sufficient leaves the question open on purpose — the model will ask
				// again rather than proceed on a vague reply.
				await handle.commit(async (tx) => {
					const state = await tx.doc(AgentClarificationDoc, conversationId, current, { requestId: current });
					state.answers = [...state.answers, composed.value];
					state.resolutions = [
						...state.resolutions,
						{ questionId: input.answerTo!, resolvedAt: composed.value.answeredAt, resolvedBy: "application", basis: { kind: "answer", answerAt: composed.value.answeredAt } },
					];
				}, context);
				const submission = await handle.submit({ type: "input", content: text, requestId: answerInputId(input.answerTo) }, context);
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
			// The Harness queues it in `pi.inbox`; the outcome says so rather than
			// letting the caller believe it started immediately.
			if (await busy()) {
				const submission = await handle.submit({ type: "input", content: text, requestId: `queued:${stableSlug(text)}` }, context);
				return { kind: "queued", submission, reason: "a round is running; the input is queued for the next boundary" };
			}

			// ── A new request (or a restatement of the current one) ───────────────
			const requestId = input.requestId ?? current ?? `req-${now().toString(36)}`;
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
			const submission = await handle.submit({ type: "input", content: text, requestId: requestInputId(requestId) }, context);
			return { kind: "request", requestId, requestVersion, submission };
		},

		async readRequest() {
			const requestId = await activeRequestId();
			if (requestId === undefined) {
				return { requestId: undefined, requestVersion: 0, text: "", openQuestionIds: [], questions: [], answers: [], plans: [] };
			}
			const request = await handle.commit(async (tx) => {
				const doc = await tx.doc(AgentRequestDoc, conversationId, requestId, { requestId });
				return { requestVersion: doc.requestVersion, text: doc.text };
			}, context);
			const clarification = await readClarification(requestId);
			const plans: Plan[] = [];
			for (const planId of knownPlanIds) {
				const raw = await harness.snapshot(AgentPlanDoc, conversationId, planId, context);
				if (raw === undefined || raw.version === 0) continue;
				const checked = validatePlan(raw);
				if (checked.ok) plans.push(checked.value);
			}
			return {
				requestId,
				requestVersion: request?.requestVersion ?? 0,
				text: request?.text ?? "",
				openQuestionIds: openQuestionIds(clarification),
				questions: clarification.questions,
				answers: clarification.answers,
				plans,
			};
		},

		async status() {
			const requestId = await activeRequestId();
			const clarification = requestId === undefined ? undefined : await readClarification(requestId);
			return {
				busy: await busy(),
				openQuestionIds: clarification === undefined ? [] : openQuestionIds(clarification),
				requestId,
			};
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

function emptyClarification(): ClarificationState {
	return { schemaVersion: 1, questions: [], answers: [], resolutions: [] };
}
