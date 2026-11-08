import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "../context.js";
import type { PromptOptions } from "../prompts/system.js";
import { REOPEN_MESSAGE } from "../prompts/report.js";
import { approvedWriteCount, gatedCalls, toolCallsFrom } from "../report.js";
import { highestEvidenceNumber } from "../evidence-id.js";
import { stripSystemReminder } from "../system-reminder.js";
import { connectedPlatforms } from "../policy.js";
import { retrySummary, withLLMRetries } from "../../llm/failures.js";
import { retryDelaysMs } from "../../llm/config.js";
import { createProvider } from "../../llm/factory.js";
import {
  checkLLMReadiness,
  notConfiguredMessage,
} from "../../config/readiness.js";
import { loadConfig } from "../../config/store.js";
import { getGitHubIntegration } from "../../integrations/store.js";
import { getSession } from "../../session/store.js";
import { getNextSeq } from "../../session/transcript-store.js";
import { seedRows } from "../../session/seed.js";
import {
  publishTextMessageContent,
  publishInterrupt,
  publishRunRetrying,
  publishTranscriptItem,
} from "../../session/stream.js";
import { continueCard } from "../../session/transcript.js";
import {
  generateSessionTitle,
  buildAlertTitleSource,
} from "../../session/title.js";
import { getFleetView } from "../../fleet/connections.js";
import { logger } from "../../logger.js";
import type {
  AlertGroupContext,
  NormalizedAlert,
  SessionMeta,
} from "@nightwarden/shared";
import type {
  ChatResponse,
  LLMProvider,
  ProviderMessage,
  ToolSchema,
} from "../../llm/types.js";
import type { PendingHumanInput } from "../../session/gate-store.js";
import { RunState } from "./run-state.js";
import type { RunContext, RunOutcome } from "./run-state.js";
import { currentToolset, runOneTurn } from "./run-turn.js";

export type { RunOutcome };

/* A placeholder either way: the title model replaces it seconds later. Shared
   with the chat route, which writes the row before handing out its id. */
export function buildSessionMeta(
  sessionId: string,
  alert: NormalizedAlert | null,
  userMessage: string | undefined,
): SessionMeta {
  return {
    sessionId,
    title:
      alert == null && userMessage
        ? userMessage.slice(0, 80)
        : (alert?.alertType ?? "chat"),
    createdAt: new Date().toISOString(),
  };
}

export interface RunSessionInput {
  sessionId: string;
  // As the sender grouped them, investigated as one incident with none elected.
  // Absent on a resume, which recovers them from the session row.
  alerts?: NormalizedAlert[];
  seed?: ProviderMessage[];
  userMessage?: string;
  // The sender's id for userMessage, which the transcript draws its bubble under.
  clientMessageId?: string;
  // The user picked Investigate before they typed. An alert says the same
  // thing by existing; absent on a resume, which reads the session's own row.
  investigation?: boolean;
  // The person reopened a closed investigation, and userMessage is their reason.
  reopen?: boolean;
  // Aborts the LLM request in flight when the dispatcher stops this run.
  signal?: AbortSignal;
  // When true: seed prior transcript and run exactly one closing turn (no tools),
  // then finish. Used when the user declines a continue-request interrupt.
  standDown?: boolean;
}

// The driver: it sets the run up, then loops runOneTurn until a turn ends the
// run or the time budget runs out and it parks a continue-request.
export async function runSession(input: RunSessionInput): Promise<RunOutcome> {
  const { sessionId, signal } = input;

  const stored = await getSession(sessionId);
  // A resume carries none, so the session's own record answers instead.
  const allAlerts =
    input.alerts ?? (stored?.alerts ?? []).map((entry) => entry.alert);
  const alert = allAlerts[0] ?? null;

  // An alert opens an investigation; otherwise the row answers, never an artifact
  // a previous run left behind. The row is a ratchet, so this only turns on.
  const opensInvestigation =
    allAlerts.length > 0 ||
    (input.investigation ?? false) ||
    (stored?.investigation ?? false);

  const log = logger.child({
    sessionId,
    alertType: alert?.alertType ?? "chat",
    alertCount: allAlerts.length,
    investigation: opensInvestigation,
  });

  // Backstop, not the primary gate: the routes that start a run refuse first.
  // Reaching here unconfigured means a caller bypassed them, so fail loudly.
  const readiness = await checkLLMReadiness();
  if (!readiness.ready) {
    throw new Error(notConfiguredMessage(readiness.missing));
  }
  // llm is the active provider's block flattened for the SDK; config carries the
  // loop and sandbox budgets, which are provider-independent.
  const { config: llm, apiKey } = readiness;
  const config = await loadConfig();

  // Transient provider errors are waited out instead of killing the run; each
  // wait is streamed to the frontend as live status.
  const chatWithRetries = async (
    provider: LLMProvider,
    messages: readonly ProviderMessage[],
    toolSchemas: ToolSchema[],
    turn: number,
    // The run's effective signal: the user's stop, or that combined with
    // the investigation deadline once the loop has one.
    chatSignal: AbortSignal | undefined = signal,
  ): Promise<ChatResponse> =>
    await withLLMRetries(
      async () =>
        await provider.chat(
          messages,
          toolSchemas,
          (d) => publishTextMessageContent(sessionId, turn, d),
          chatSignal,
        ),
      {
        signal: chatSignal,
        delays: retryDelaysMs(config.maxRetries),
        onRetry: (notice) => {
          log.warn(
            { attempt: notice.attempt, delayMs: notice.delayMs },
            "transient LLM error, retrying",
          );
          publishRunRetrying({
            sessionId,
            attempt: notice.attempt + 1,
            maxAttempts: notice.maxAttempts,
            delaySeconds: Math.round(notice.delayMs / 1000),
            summary: retrySummary(notice),
          });
        },
      },
    );

  // The rows the model is handed, dead exchanges unwound, so the stage and the
  // allowances derive from what it sees rather than from turns it never gets.
  const priorRows = await seedRows(sessionId);
  const seeded = input.seed ?? [];
  const state = new RunState(
    sessionId,
    await getNextSeq(sessionId),
    highestEvidenceNumber(priorRows) + 1,
    seeded,
    priorRows,
  );
  // Constant for the run, so counted once here rather than re-scanned per turn.
  const approvedWrites = approvedWriteCount(
    gatedCalls(toolCallsFrom(priorRows)),
  );

  /* One turn with no tools, so a run that stands down still ends on words
     addressed to the reader rather than on its own reasoning. */
  const standDownTurn = async (
    closer: LLMProvider,
    ending: string,
  ): Promise<RunOutcome> => {
    try {
      const closing = await chatWithRetries(
        closer,
        state.conversation(),
        [],
        state.nextSeq,
      );
      state.enqueue("assistant", closing.parts);
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    await state.flush();
    if (signal?.aborted) {
      log.info("run stopped by user during the closing turn");
      return "stopped";
    }
    log.info(ending);
    return "completed";
  };

  // User declined a continue-request: replay the transcript and run one
  // free-form closing turn with no tools, then finish.
  if (input.standDown) {
    const { systemPrompt } = buildChatContext(
      undefined,
      undefined,
      opensInvestigation,
    );
    log.info("time budget ended: user chose to end, running closing turn");
    return await standDownTurn(
      createProvider(systemPrompt, llm, apiKey),
      "investigation ended after user declined to continue",
    );
  }

  log.info(
    { alertLabels: alert?.labels ?? null, isChat: alert == null },
    "investigation started",
  );

  const fleetView = getFleetView();
  const integration = await getGitHubIntegration();
  // Assembled once, before the prompt that describes it, so the prose and the
  // tools it describes are derived from one value and cannot disagree.
  state.offered = await currentToolset(opensInvestigation);
  const promptOptions: PromptOptions = {
    budgetMinutes: Math.max(1, Math.round(config.checkInAfterMs / 60_000)),
    repo:
      integration === null
        ? null
        : `${integration.repoOwner}/${integration.repoName}`,
    fleetTools: connectedPlatforms().size > 0,
  };
  const { systemPrompt, openingTurn } =
    allAlerts.length > 0
      ? buildInitialContext(allAlerts, fleetView, promptOptions, {
          // The worst any delivery of this group admitted to leaving out.
          droppedAlerts: (stored?.alerts ?? []).reduce(
            (n, e) => Math.max(n, e.droppedAlerts),
            0,
          ),
          // The most recent delivery that described the group: later ones are
          // the same group re-notified, and the newest labels are the live ones.
          groupContext: (stored?.alerts ?? []).reduce<AlertGroupContext | null>(
            (latest, e) => e.groupContext ?? latest,
            null,
          ),
        })
      : buildChatContext(fleetView, promptOptions, opensInvestigation);
  const provider = createProvider(systemPrompt, llm, apiKey);

  if (seeded.length > 0) {
    // Written immediately so the frontend shows the turn the moment it is sent,
    // rather than waiting for the assistant's reply to flush both at once.
    if (input.userMessage) {
      state.enqueue(
        "user",
        [{ type: "text", text: stripSystemReminder(input.userMessage) }],
        input.clientMessageId,
      );
    }
    // After the reason, so the model reads why before it is told what reopening means.
    if (input.reopen === true)
      state.sendSystemReminder("reopen", REOPEN_MESSAGE);
    await state.flush();
  } else {
    // An alert has no human to type the first turn, so NightWarden writes it and
    // marks it as its own. A person's own first message is theirs.
    if (input.userMessage === undefined && openingTurn !== null) {
      state.sendSystemReminder("alert_opening", openingTurn);
    } else {
      state.enqueue(
        "user",
        [{ type: "text", text: stripSystemReminder(input.userMessage ?? "") }],
        input.clientMessageId,
      );
    }
    await state.flush();
    // Brand-new session only: refine the title in the background. Chat uses the
    // message; an alert, a compact summary.
    const titleSource = input.userMessage ?? buildAlertTitleSource(allAlerts);
    void generateSessionTitle(sessionId, titleSource, llm, apiKey);
  }

  // Computed once and never moved, so a run cannot outrun its own clock: every
  // turn spends the same budget and the check-in below always arrives.
  const deadline = Date.now() + config.checkInAfterMs;
  // One shared instant rather than a duration each layer counts separately.
  // Distinct from `signal`, which means the user stopped the run.
  const outOfTime = AbortSignal.timeout(config.checkInAfterMs);
  const runSignal = signal ? AbortSignal.any([signal, outOfTime]) : outOfTime;

  const ctx: RunContext = {
    state,
    sessionId,
    signal,
    runSignal,
    outOfTime,
    deadline,
    log,
    opensInvestigation,
    approvedWrites,
    llm,
    toolCallCeilingMs: config.toolCallCeilingMs,
    // The provider is bound in here, so the turn cycle never sees it.
    chat: (messages, tools, turn, chatSignal) =>
      chatWithRetries(provider, messages, tools, turn, chatSignal),
  };

  while (Date.now() < deadline) {
    const result = await runOneTurn(ctx);
    if (result.kind === "outcome") return result.outcome;
    if (result.kind === "stand_down") {
      return await standDownTurn(
        provider,
        "investigation ended with a candidate the run left open",
      );
    }
    /* The two turns that end an investigation, in the order the reader needs
       them: the write-up is filed, and only then is the model given words. */
    if (result.kind === "budget") break;
  }

  // No underlying tool call, so the synthetic toolCallId only keys the interrupt
  // row - the resolver branches on kind, not the transcript.
  const continueId = randomUUID();
  const continueInterrupt: PendingHumanInput = {
    sessionId,
    toolCallId: continueId,
    kind: "continue",
    completedResults: [],
    claimedAt: null,
  };
  await state.flush(continueInterrupt);
  publishTranscriptItem({
    sessionId,
    item: continueCard(continueId, { phase: "awaiting_human" }),
  });
  publishInterrupt({
    sessionId,
    toolCallId: continueId,
    toolName: "",
    input: {},
    kind: "continue",
  });
  log.info(
    { turn: state.turn },
    "time budget reached: suspended with continue request",
  );
  return "suspended";
}
