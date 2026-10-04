import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { configStore } from "../config-store.js";
import { nats } from "../nats.js";
import { getOrCreateSession } from "../router/sessions.js";
import { listSessionEvents } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { RUNTIME_PROMPT_INTAKE_FAILED_USER_MESSAGE } from "./intake-failure.js";
import { RuntimeSessionDispatcher } from "./session-dispatcher.js";
import { startRuntimeSession } from "./session-launcher.js";

const crashRecoveryStub = { acceptingDeliveries: true } as unknown as RuntimeCrashRecoveryCoordinator;
const SESSION_KEY = "agent:main:main";

let stateDir: string | null = null;
let runtimeEvents: Array<{ topic: string; data: Record<string, unknown> }>;
let responses: Array<{ topic: string; data: Record<string, unknown> }>;

function withoutAgents() {
  const config = configStore.getConfig();
  spyOn(configStore, "getConfig").mockReturnValue({ ...config, agents: {}, defaultAgent: "missing" });
}

function createDispatcher() {
  return new RuntimeSessionDispatcher({
    instanceId: "test",
    maxConcurrentSessions: 10,
    interactiveReservedSessions: 0,
    safeEmit: async (topic, data) => {
      runtimeEvents.push({ topic, data });
    },
    notifyRuntimeRecoveryExhausted: async () => {},
    getConfigModel: () => "test-model",
    crashRecovery: crashRecoveryStub,
  });
}

function intakeFailures() {
  return listSessionEvents(SESSION_KEY).filter((event) => event.eventType === "dispatch.intake_failed");
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-runtime-intake-failure-");
  getOrCreateSession(SESSION_KEY, "main", stateDir, { name: "main" });
  configStore.refresh();
  runtimeEvents = [];
  responses = [];
  spyOn(nats, "emit").mockImplementation(async (topic: string, data: Record<string, unknown>) => {
    if (topic.endsWith(".response")) responses.push({ topic, data });
  });
});

afterEach(async () => {
  mock.restore();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("runtime prompt intake failure", () => {
  it("acknowledges a prompt with no agent, records a durable trace, and notifies the chat user", async () => {
    withoutAgents();
    const dispatcher = createDispatcher();
    const startStreamingSession = spyOn(dispatcher, "startStreamingSession").mockResolvedValue();
    const source = { channel: "whatsapp", accountId: "main", chatId: "5511999999999" };

    await expect(
      dispatcher.handlePrompt("main", {
        prompt: "hello after reroute",
        source,
        context: { messageId: "wamid-1" },
      } as never),
    ).resolves.toBeUndefined();

    expect(startStreamingSession).not.toHaveBeenCalled();
    const [event] = intakeFailures();
    expect(event).toMatchObject({
      sessionName: "main",
      eventGroup: "dispatch",
      status: "failed",
      error: "Runtime prompt intake failed (no_agent)",
      messageId: "wamid-1",
    });
    expect(event?.payloadJson).toMatchObject({ reason: "no_agent", stage: "dispatch", agentId: "main" });
    expect(runtimeEvents).toEqual([
      {
        topic: "ravi.session.main.runtime",
        data: expect.objectContaining({ type: "dispatch.dropped", reason: "intake_failed:no_agent" }),
      },
    ]);
    expect(responses).toEqual([
      {
        topic: "ravi.session.main.response",
        data: expect.objectContaining({
          response: `Error: ${RUNTIME_PROMPT_INTAKE_FAILED_USER_MESSAGE}`,
          target: source,
        }),
      },
    ]);
  });

  it("records the immediate-path drop without a channel notice for non-chat sources", async () => {
    withoutAgents();
    const dispatcher = createDispatcher();

    await dispatcher.handlePromptImmediate("main", { prompt: "cron tick" });

    expect(intakeFailures()).toHaveLength(1);
    expect(responses).toEqual([]);
  });

  it("records the launch-stage drop when the agent disappears before the runtime starts", async () => {
    withoutAgents();
    const source = { channel: "slack", accountId: "ravi-slack", chatId: "C123" };

    await expect(
      startRuntimeSession({
        sessionName: "main",
        prompt: { prompt: "@ravi ping", source, _agentId: "gone" },
        configModel: "test-model",
        instanceId: "test",
        streamingSessions: new Map(),
        stashedMessages: new Map(),
        safeEmit: async (topic, data) => {
          runtimeEvents.push({ topic, data });
        },
        drainPendingStarts: () => {},
        crashRecovery: crashRecoveryStub,
      }),
    ).resolves.toBeUndefined();

    const [event] = intakeFailures();
    expect(event?.payloadJson).toMatchObject({ reason: "no_agent", stage: "launch", agentId: "gone" });
    expect(responses).toHaveLength(1);
    expect(responses[0]?.data.target).toEqual(source);
  });
});
