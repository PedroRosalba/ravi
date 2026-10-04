import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbSetSetting } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  buildSlackImmediateModalView,
  matchSlackImmediateModalRule,
  parseSlackImmediateModalRules,
  SLACK_IMMEDIATE_MODALS_SETTING,
  type SlackImmediateModalRule,
} from "./immediate-modals.js";
import { SlackSocketModeService } from "./socket-mode.js";

const modalView = {
  type: "modal",
  callback_id: "workflow_submit",
  title: { type: "plain_text", text: "Novo pedido" },
  blocks: [],
};

const rule: SlackImmediateModalRule = { actionId: "workflow_open", blockId: "workflow_actions", view: modalView };

function blockActionsEnvelope(envelopeId: string, view?: Record<string, unknown>) {
  return {
    envelope_id: envelopeId,
    payload: {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U123" },
      channel: { id: "C123" },
      trigger_id: "trigger-1",
      container: { type: view ? "view" : "message", channel_id: "C123", message_ts: "1713000000.000100" },
      message: { ts: "1713000000.000100" },
      ...(view ? { view } : {}),
      actions: [{ type: "button", block_id: "workflow_actions", action_id: "workflow_open", value: "req-42" }],
    },
  };
}

function createService(options: {
  rules?: SlackImmediateModalRule[];
  viewsOpen: (input: { triggerId: string; view: Record<string, unknown> }) => Promise<unknown>;
}) {
  const order: string[] = [];
  const interactions: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const service = new SlackSocketModeService({
    appToken: "xapp-test",
    botToken: "xoxb-test",
    accountId: "acct-1",
    ...(options.rules ? { getImmediateModalRules: () => options.rules ?? [] } : {}),
    publishPrompt: async () => {},
    publishInteraction: async (topic, payload) => {
      order.push("publish");
      interactions.push({ topic, payload });
    },
    webClient: {
      viewsOpen: async (input: { triggerId: string; view: Record<string, unknown> }) => {
        order.push("viewsOpen");
        return options.viewsOpen(input);
      },
    } as never,
  });
  return { service, order, interactions };
}

describe("parseSlackImmediateModalRules", () => {
  it("returns no rules for an empty setting", () => {
    expect(parseSlackImmediateModalRules(null)).toEqual([]);
    expect(parseSlackImmediateModalRules("  ")).toEqual([]);
  });

  it("parses valid rules and trims ids", () => {
    expect(parseSlackImmediateModalRules(JSON.stringify([{ actionId: " workflow_open ", view: modalView }]))).toEqual([
      { actionId: "workflow_open", view: modalView },
    ]);
  });

  it("rejects invalid rules with a precise message", () => {
    expect(() => parseSlackImmediateModalRules("{")).toThrow("must be a JSON array");
    expect(() => parseSlackImmediateModalRules("{}")).toThrow("must be a JSON array");
    expect(() => parseSlackImmediateModalRules(JSON.stringify([{ view: modalView }]))).toThrow(
      "[0] requires actionId or blockId",
    );
    expect(() => parseSlackImmediateModalRules(JSON.stringify([{ callbackId: "x", view: modalView }]))).toThrow(
      "requires actionId or blockId",
    );
    expect(() => parseSlackImmediateModalRules(JSON.stringify([{ actionId: 1, view: modalView }]))).toThrow(
      "[0].actionId must be a non-empty string",
    );
    expect(() =>
      parseSlackImmediateModalRules(JSON.stringify([{ actionId: "a", view: { type: "home", blocks: [] } }])),
    ).toThrow("[0].view must be a Slack modal view");
  });
});

describe("matchSlackImmediateModalRule", () => {
  const interaction = {
    interactionType: "block_actions",
    triggerId: "trigger-1",
    accountId: "acct-1",
    actionId: "workflow_open",
    blockId: "workflow_actions",
  };

  it("requires every configured field to match", () => {
    expect(matchSlackImmediateModalRule([rule], interaction)).toBe(rule);
    expect(matchSlackImmediateModalRule([rule], { ...interaction, blockId: "other" })).toBeUndefined();
    expect(matchSlackImmediateModalRule([{ ...rule, accountId: "acct-2" }], interaction)).toBeUndefined();
    expect(matchSlackImmediateModalRule([{ ...rule, callbackId: "cb" }], interaction)).toBeUndefined();
    expect(
      matchSlackImmediateModalRule([{ ...rule, callbackId: "cb" }], { ...interaction, viewCallbackId: "cb" }),
    ).toBeDefined();
  });

  it("only matches block_actions that carry a trigger id", () => {
    expect(
      matchSlackImmediateModalRule([rule], { ...interaction, interactionType: "view_submission" }),
    ).toBeUndefined();
    expect(matchSlackImmediateModalRule([rule], { ...interaction, triggerId: undefined })).toBeUndefined();
  });
});

describe("buildSlackImmediateModalView", () => {
  it("fills private_metadata with the click context without mutating the rule", () => {
    const view = buildSlackImmediateModalView(rule, {
      accountId: "acct-1",
      channelId: "C123",
      messageTs: "1713000000.000100",
      userId: "U123",
      actionId: "workflow_open",
      value: "req-42",
    });
    expect(JSON.parse(view.private_metadata as string)).toEqual({
      source: "ravi.slack.immediate_modal",
      accountId: "acct-1",
      channelId: "C123",
      messageTs: "1713000000.000100",
      userId: "U123",
      actionId: "workflow_open",
      value: "req-42",
    });
    expect(rule.view.private_metadata).toBeUndefined();
  });

  it("keeps configured private_metadata and drops an oversized value", () => {
    expect(
      buildSlackImmediateModalView({ ...rule, view: { ...modalView, private_metadata: "fixed" } }, {}).private_metadata,
    ).toBe("fixed");
    const metadata = JSON.parse(
      buildSlackImmediateModalView(rule, { channelId: "C123", value: "x".repeat(4000) }).private_metadata as string,
    );
    expect(metadata).toEqual({ source: "ravi.slack.immediate_modal", channelId: "C123" });
  });
});

describe("Slack Socket Mode immediate modals", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-immediate-modal-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("opens the configured modal before publishing the interaction", async () => {
    const opened: Array<{ triggerId: string; view: Record<string, unknown> }> = [];
    const { service, order, interactions } = createService({
      rules: [rule],
      viewsOpen: async (input) => {
        opened.push(input);
        return { ok: true, view: { id: "V-opened", hash: "hash-1" } };
      },
    });

    await expect(service.handleEnvelope(blockActionsEnvelope("env-1"))).resolves.toBe("processed");

    expect(order).toEqual(["viewsOpen", "publish"]);
    expect(opened[0]?.triggerId).toBe("trigger-1");
    expect(opened[0]?.view).toMatchObject({ type: "modal", callback_id: "workflow_submit" });
    expect(interactions[0]).toEqual({
      topic: "ravi.inbound.interaction",
      payload: expect.objectContaining({
        actionId: "workflow_open",
        triggerId: "trigger-1",
        modalOpened: true,
        openedViewId: "V-opened",
        openedViewHash: "hash-1",
      }),
    });
  });

  it("falls back to a plain publish flagged with the error when views.open fails", async () => {
    const { service, order, interactions } = createService({
      rules: [rule],
      viewsOpen: async () => {
        throw new Error("Slack views.open failed: expired_trigger_id");
      },
    });

    await expect(service.handleEnvelope(blockActionsEnvelope("env-2"))).resolves.toBe("processed");

    expect(order).toEqual(["viewsOpen", "publish"]);
    expect(interactions[0]?.payload).toMatchObject({
      actionId: "workflow_open",
      modalOpened: false,
      modalOpenError: "Slack views.open failed: expired_trigger_id",
    });
  });

  it("reads rules from the slack.immediateModals setting by default", async () => {
    dbSetSetting(SLACK_IMMEDIATE_MODALS_SETTING, JSON.stringify([{ actionId: "workflow_open", view: modalView }]));
    const { service, order, interactions } = createService({
      viewsOpen: async () => ({ ok: true, view: { id: "V-opened" } }),
    });

    await service.handleEnvelope(blockActionsEnvelope("env-3"));

    expect(order).toEqual(["viewsOpen", "publish"]);
    expect(interactions[0]?.payload.modalOpened).toBe(true);
  });

  it("publishes unmatched interactions untouched and exposes view metadata", async () => {
    const { service, order, interactions } = createService({
      rules: [],
      viewsOpen: async () => ({ ok: true }),
    });

    await service.handleEnvelope(
      blockActionsEnvelope("env-4", {
        id: "V-existing",
        callback_id: "workflow_submit",
        private_metadata: '{"requestId":"req-42"}',
        hash: "hash-existing",
      }),
    );

    expect(order).toEqual(["publish"]);
    expect(interactions[0]?.payload).toMatchObject({
      viewId: "V-existing",
      viewCallbackId: "workflow_submit",
      viewPrivateMetadata: '{"requestId":"req-42"}',
      viewHash: "hash-existing",
    });
    expect(interactions[0]?.payload).not.toHaveProperty("modalOpened");
  });
});
