/**
 * WhatsAppNativeRuntime lifecycle: start/connect/disconnect/logout, QR and pairing
 * code, connectionReplaced/loggedOut, reconnect + supervisor, health/status, passkey,
 * group prewarm noise, publish retry. Ports Omni plugin.test, disconnect-status and
 * prewarm-connection-closed to the one-instance runtime.
 */

import { describe, expect, it, mock } from "bun:test";
import { WHATSAPP_CHANNEL_TYPE } from "../contract.js";
import type { Logger } from "../lib/foundation.js";
import { WhatsAppRuntimeError } from "../runtime-errors.js";
import { OWNER_JID, createHarness, flush } from "./runtime-harness.js";

function closeWith(statusCode: number, message = "closed") {
  const error = Object.assign(new Error(message), { output: { statusCode, payload: { message } } });
  return { connection: "close", lastDisconnect: { error, date: new Date() } };
}

function spyLogger() {
  return {
    debug: mock((_message: string, _data?: Record<string, unknown>) => {}),
    info: mock((_message: string, _data?: Record<string, unknown>) => {}),
    warn: mock((_message: string, _data?: Record<string, unknown>) => {}),
    error: mock((_message: string, _data?: Record<string, unknown>) => {}),
  } satisfies Logger;
}

describe("WhatsAppNativeRuntime start()", () => {
  it("never blocks and waits for pairing when no creds are stored", async () => {
    const h = createHarness({ registered: false });
    expect(h.runtime.getState()).toBe("idle");
    expect(h.runtime.health()).toEqual({ status: "starting" });

    const result = h.runtime.start();
    expect(result).toBeUndefined();
    expect(h.runtime.getState()).toBe("pairing_required");
    expect(h.runtime.health()).toEqual({ status: "starting", reason: "pairing_required" });
    await flush();
    expect(h.ensureInboundStream).toHaveBeenCalledTimes(1);
    expect(h.sockets).toHaveLength(0);
    expect(h.runtime.getStatus()).toEqual({ state: "disconnected", isConnected: false, profileName: null });
  });

  it("connects in the background with stored creds and publishes instance.connected", async () => {
    const h = createHarness();
    h.runtime.start();
    expect(h.runtime.getState()).toBe("connecting");
    expect(h.runtime.health().status).toBe("starting");

    const sock = await h.connect();
    expect(h.sockets).toHaveLength(1);
    expect(h.runtime.getState()).toBe("connected");
    expect(h.runtime.health()).toEqual({ status: "connected", connectedAt: h.clock.now });
    expect(h.runtime.getStatus()).toEqual({ state: "connected", isConnected: true, profileName: "Ravi Bot" });
    expect(sock.fake.profilePictureUrl).toHaveBeenCalledWith(OWNER_JID, "image");

    const connected = h.publishedOfType("instance.connected");
    expect(connected).toHaveLength(1);
    expect(connected[0]?.event.payload).toEqual({
      instanceId: h.instanceId,
      channelType: WHATSAPP_CHANNEL_TYPE,
      profileName: "Ravi Bot",
      profilePicUrl: "https://pps.whatsapp.net/me.jpg",
      ownerIdentifier: OWNER_JID,
    });
    expect(connected[0]?.subject).toBe(`ravi.channel.inbound.instance.connected.whatsapp-baileys.${h.instanceId}`);
  });

  it("passes the runtime caches to the socket config and strips ravi-only options", async () => {
    const h = createHarness({ socketOptions: { lidFirstEnabled: false, syncFullHistory: true } });
    await h.startAndWaitForSocket();
    const config = h.socketConfigs[0];
    expect(config?.syncFullHistory).toBe(true);
    expect(config && "lidFirstEnabled" in config).toBe(false);
    expect(typeof config?.cachedGroupMetadata).toBe("function");
    expect(typeof config?.getMessage).toBe("function");
    expect(typeof config?.shouldIgnoreJid).toBe("function");
    expect(h.runtime.isLidFirstEnabled()).toBe(false);
  });

  it("persists creds.update through saveCreds", async () => {
    const h = createHarness();
    const sock = await h.startAndWaitForSocket();
    sock.emit("creds.update", { me: { id: OWNER_JID } });
    await flush();
    expect(h.saveCreds).toHaveBeenCalledTimes(1);
  });

  it("reports failed/missing_dependency when the Baileys library cannot load", async () => {
    const h = createHarness({ loadLibrary: async () => Promise.reject(new Error("Cannot find module 'baileys'")) });
    h.runtime.start();
    await flush();
    expect(h.runtime.getState()).toBe("failed");
    expect(h.runtime.health()).toEqual({ status: "failed", reason: "missing_dependency" });
    expect(h.runtime.getStatus().state).toBe("error");
  });
});

describe("QR and pairing", () => {
  it("publishes instance.qr_code and republishes the pending QR on a second connect", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    const first = await h.runtime.connect();
    expect(first.status).toBe("connecting");
    await flush();
    h.socket().emit("connection.update", { qr: "2@QR-PAYLOAD" });
    await flush();

    expect(h.runtime.getState()).toBe("qr");
    expect(h.runtime.health()).toEqual({ status: "starting", reason: "qr_pending" });
    expect(h.runtime.getStatus().state).toBe("qr");
    const qr = h.publishedOfType("instance.qr_code");
    expect(qr).toHaveLength(1);
    const payload = qr[0]?.event.payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["instanceId", "channelType", "qrCode", "expiresAt"]);
    expect(payload.qrCode).toBe("2@QR-PAYLOAD");
    expect(typeof payload.expiresAt).toBe("number");

    const second = await h.runtime.connect();
    expect(second.status).toBe("qr");
    expect(h.publishedOfType("instance.qr_code")).toHaveLength(2);
    expect(h.sockets).toHaveLength(1);
  });

  it("connect() on a connected instance is a no-op", async () => {
    const h = createHarness();
    await h.connect();
    expect(await h.runtime.connect()).toEqual({ status: "connected", message: "Instance already connected" });
    expect(h.sockets).toHaveLength(1);
  });

  it("forceNewQr clears auth and opens a fresh socket", async () => {
    const h = createHarness();
    const first = await h.connect();
    const result = await h.runtime.connect({ forceNewQr: true });
    expect(result.status).toBe("connecting");
    await flush();
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(first.fake.end).toHaveBeenCalled();
    expect(h.sockets).toHaveLength(2);
  });

  it("rejects invalid connect options at the boundary", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await expect(h.runtime.call("connection.connect", { whatsapp: { connectTimeoutMs: -1 } })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("requests a pairing code once the socket is ready", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    const pending = h.runtime.call("connection.pairingCode", { phoneNumber: "+55 (11) 99999-0000" });
    await flush();
    h.socket().emit("connection.update", { qr: "2@QR" });
    expect(await pending).toEqual({ code: "ABCD1234" });
    expect(h.socket().fake.requestPairingCode).toHaveBeenCalledWith("5511999990000");
  });

  it("rejects short phone numbers with 400", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await expect(h.runtime.requestPairingCode("12345")).rejects.toMatchObject({ status: 400 });
  });
});

describe("disconnect / logout", () => {
  it("disconnect closes the socket, publishes instance.disconnected and never reconnects (#1169)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("connection.disconnect", {});

    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "user_disconnect" });
    expect(sock.fake.end).toHaveBeenCalled();
    expect(sock.fake.logout).not.toHaveBeenCalled();
    expect(sock.fake.ev.listenerCount("connection.update")).toBe(0);
    const disconnected = h.publishedOfType("instance.disconnected");
    expect(disconnected.map((record) => record.event.payload)).toEqual([
      {
        instanceId: h.instanceId,
        channelType: WHATSAPP_CHANNEL_TYPE,
        reason: "User requested disconnect",
        willReconnect: false,
      },
    ]);
    expect(h.manual.pending.size).toBe(0);
    await flush(30);
    expect(h.sockets).toHaveLength(1);
  });

  it("disconnect without a live socket still resets state and emits nothing", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await h.runtime.disconnect();
    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.publishedOfType("instance.disconnected")).toHaveLength(0);
  });

  it("logout unlinks the device, clears auth and reports logged_out", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("connection.logout", {});
    expect(sock.fake.logout).toHaveBeenCalledTimes(1);
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(h.runtime.getState()).toBe("logged_out");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "logged_out" });
    expect(h.runtime.getStatus()).toEqual({ state: "logged_out", isConnected: false, profileName: null });
    expect(h.publishedOfType("instance.disconnected")[0]?.event.payload).toMatchObject({ reason: "Logged out" });
  });

  it("stop() closes the socket and later calls fail with 503", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.stop();
    expect(sock.fake.end).toHaveBeenCalled();
    expect(h.runtime.getState()).toBe("stopped");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "stopped" });
    await expect(h.runtime.call("connection.connect", {})).rejects.toMatchObject({
      status: 503,
      code: "NOT_CONNECTED",
    });
  });
});

describe("socket loss", () => {
  it("connectionReplaced (440) drops the socket and does not reconnect", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("connection.update", closeWith(440, "Stream Errored (conflict)"));
    await flush(30);

    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "connection_replaced" });
    expect(sock.fake.end).toHaveBeenCalled();
    expect(h.sockets).toHaveLength(1);
    expect(h.manual.pending.size).toBe(0);
    expect(h.publishedOfType("instance.disconnected")[0]?.event.payload).toMatchObject({
      reason: "Connection replaced by another session",
      willReconnect: false,
    });
  });

  it("loggedOut (401) clears creds and reports logged_out", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("connection.update", closeWith(401, "Connection Failure"));
    await flush();

    expect(h.runtime.getState()).toBe("logged_out");
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(h.auth.flags.registered).toBe(false);
    expect(h.publishedOfType("instance.disconnected")[0]?.event.payload).toMatchObject({
      reason: "Logged out from WhatsApp",
      willReconnect: false,
    });
    expect(h.manual.pending.size).toBe(0);
  });

  it("reconnects an authenticated instance with backoff after a transient close", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("connection.update", closeWith(428, "Connection Closed"));
    await flush(1);
    expect(["reconnecting", "connecting"]).toContain(h.runtime.getState());
    await flush(30);
    expect(h.sockets).toHaveLength(2);
    h.socket().emit("connection.update", { connection: "open" });
    await flush();
    expect(h.runtime.getState()).toBe("connected");
    expect(h.runtime.health()).toMatchObject({ status: "connected", reconnectCount: 1 });
    expect(h.publishedOfType("instance.connected")).toHaveLength(2);
  });

  it("the supervisor re-arms a connect after a failed socket creation", async () => {
    let calls = 0;
    const h = createHarness({
      library: {
        createSocket: mock(async () => {
          calls++;
          throw new Error("ENETUNREACH");
        }),
      },
    });
    h.runtime.start();
    await flush();
    expect(calls).toBe(1);
    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "connect_failed" });
    expect(h.manual.delays()).toEqual([1000]);

    h.manual.runAll();
    await flush();
    expect(calls).toBe(2);
    expect(h.manual.delays()).toEqual([2000]);
  });

  it("the supervisor never fires after a manual disconnect", async () => {
    const h = createHarness({
      library: {
        createSocket: mock(async () => {
          throw new Error("ENETUNREACH");
        }),
      },
    });
    h.runtime.start();
    await flush();
    expect(h.manual.pending.size).toBe(1);
    await h.runtime.disconnect();
    expect(h.manual.pending.size).toBe(0);
  });
});

describe("passkey", () => {
  it("tracks a passkey request and forwards the credential", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await h.runtime.connect();
    await flush();
    const sock = h.socket();
    sock.emit("connection.update", { passkey: { state: "request", publicKey: { challenge: "abc" } } });
    await flush();
    expect(h.runtime.getPasskeyState()).toMatchObject({ state: "request", publicKey: { challenge: "abc" } });

    await h.runtime.submitPasskeyResponse({ id: "cred" } as unknown as Parameters<
      typeof h.runtime.submitPasskeyResponse
    >[0]);
    expect(sock.fake.sendPasskeyResponse).toHaveBeenCalledTimes(1);
    expect(h.runtime.getPasskeyState()?.state).toBe("confirming");
  });

  it("auto-confirms when WhatsApp skips the handoff UX", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await h.runtime.connect();
    await flush();
    const sock = h.socket();
    sock.emit("connection.update", { passkey: { state: "confirmation", code: "123", skipHandoffUX: true } });
    await flush();
    expect(sock.fake.sendPasskeyConfirmation).toHaveBeenCalledTimes(1);
    expect(h.runtime.getPasskeyState()?.state).toBe("confirming");
  });

  it("confirmPasskey without a pending confirmation is a 400", async () => {
    const h = createHarness();
    await h.connect();
    await expect(h.runtime.confirmPasskey()).rejects.toBeInstanceOf(WhatsAppRuntimeError);
  });
});

describe("group prewarm after connect", () => {
  const GROUP = "120363000000000001@g.us";
  const groups = {
    [GROUP]: {
      id: GROUP,
      subject: "Equipe",
      participants: [
        { id: "111@lid", admin: null },
        { id: "222@lid", admin: "admin" as const },
      ],
    },
  };

  it("prefetches metadata and warms device/session caches for every participant", async () => {
    const h = createHarness({ socket: { groups } });
    const sock = await h.connect();
    await flush();
    expect(sock.fake.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    expect(sock.fake.getUSyncDevices).toHaveBeenCalledWith(["111@lid", "222@lid"], true, false);
    expect(sock.fake.assertSessions).toHaveBeenCalledWith(["111@lid", "222@lid"], false);
    const cached = await h.socketConfigs[0]?.cachedGroupMetadata?.(GROUP);
    expect(cached?.subject).toBe("Equipe");
  });

  it("treats 'Connection Closed' during prefetch as reconnect noise (debug, not warn)", async () => {
    const logger = spyLogger();
    const h = createHarness({ logger });
    h.runtime.start();
    await flush();
    const sock = h.socket();
    sock.fake.groupFetchAllParticipating.mockImplementation(async () => {
      throw new Error("Connection Closed");
    });
    sock.emit("connection.update", { connection: "open" });
    await flush();
    const warned = logger.warn.mock.calls.map((call) => call[0]);
    expect(warned).not.toContain("groupFetchAllParticipating failed");
    expect(logger.debug.mock.calls.map((call) => call[0])).toContain(
      "Group metadata prefetch skipped; socket closed during reconnect",
    );
    expect(h.runtime.getState()).toBe("connected");
  });

  it("still warns for other prefetch failures", async () => {
    const logger = spyLogger();
    const h = createHarness({ logger });
    h.runtime.start();
    await flush();
    const sock = h.socket();
    sock.fake.groupFetchAllParticipating.mockImplementation(async () => {
      throw new Error("rate-overlimit");
    });
    sock.emit("connection.update", { connection: "open" });
    await flush();
    expect(logger.warn.mock.calls.map((call) => call[0])).toContain("groupFetchAllParticipating failed");
  });
});

describe("CHANNEL_INBOUND publishing", () => {
  it("re-ensures the stream and retries a failed publish once", async () => {
    const h = createHarness({ publishFailTimes: 1 });
    await h.connect();
    expect(h.ensureInboundStream).toHaveBeenCalledTimes(2);
    expect(h.publishedOfType("instance.connected")).toHaveLength(1);
  });

  it("keeps running when the stream check fails at start", async () => {
    const h = createHarness({ ensureInboundStream: async () => Promise.reject(new Error("jetstream not enabled")) });
    await h.connect();
    expect(h.runtime.getState()).toBe("connected");
  });
});
