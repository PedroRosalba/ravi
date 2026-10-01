/**
 * Client side of the native WhatsApp RPC.
 *
 * The `ravi channels` runner owns the Baileys sockets and answers requests on
 * `_RAVI.channels.whatsapp.rpc.<instanceId>`. The daemon, gateway and CLI call it
 * through `requestWhatsAppRpc`, which turns every failure into an `OmniApiError` so
 * callers written against the Omni REST client (and OmniSender's 5xx retry policy)
 * keep working unchanged.
 */

import { randomUUID } from "node:crypto";
import { JSONCodec } from "nats";
import { ensureConnected } from "../../nats.js";
import { OmniApiError } from "../../omni/client.js";
import {
  DEFAULT_WHATSAPP_RPC_TIMEOUT_MS,
  WHATSAPP_RPC_ERROR_CODES,
  WHATSAPP_RPC_PROTOCOL,
  WHATSAPP_RPC_SCHEMA_VERSION,
  WhatsAppRpcParamsSchemas,
  WhatsAppRpcResponseSchema,
  whatsappRpcSubject,
  type WhatsAppRpcMethod,
  type WhatsAppRpcParams,
  type WhatsAppRpcRequest,
  type WhatsAppRpcResult,
} from "./contract.js";

const codec = JSONCodec<unknown>();

/** Client-only code: the runner answered with something that is not a valid RPC response. */
export const WHATSAPP_RPC_INVALID_RESPONSE_CODE = "WHATSAPP_RPC_INVALID_RESPONSE" as const;

/** The subset of a NATS connection the client needs (lets tests pass a fake). */
export interface WhatsAppRpcConnection {
  request(subject: string, data: Uint8Array, options: { timeout: number }): Promise<{ data: Uint8Array }>;
}

export interface WhatsAppRpcRequestOptions {
  /** Defaults to DEFAULT_WHATSAPP_RPC_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to the shared lazy NATS connection (`ensureConnected()`). */
  connection?: WhatsAppRpcConnection;
}

export const WHATSAPP_RUNNER_UNAVAILABLE_MESSAGE =
  "The native WhatsApp runner is not answering. Start it with `ravi channels start` (or `ravi channels restart`) and retry.";

/** NATS client error codes that mean "no usable connection to the server". */
const NATS_CONNECTION_ERROR_CODES = new Set([
  "CONNECTION_REFUSED",
  "CONNECTION_CLOSED",
  "CONNECTION_DRAINING",
  "CONNECTION_TIMEOUT",
  "DISCONNECT",
]);

function natsErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runnerUnavailable(instanceId: string, method: WhatsAppRpcMethod, details: string): OmniApiError {
  return new OmniApiError(`${WHATSAPP_RUNNER_UNAVAILABLE_MESSAGE} (instance ${instanceId}, ${method})`, {
    status: 503,
    code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable,
    details,
  });
}

/** Map a NATS request failure to the Omni-style error callers already handle. */
export function mapWhatsAppRpcTransportError(
  err: unknown,
  context: { instanceId: string; method: WhatsAppRpcMethod; timeoutMs: number },
): OmniApiError {
  if (err instanceof OmniApiError) return err;
  const code = natsErrorCode(err);
  if (code === "503") return runnerUnavailable(context.instanceId, context.method, "no responders");
  if (code === "TIMEOUT") {
    return new OmniApiError(
      `Native WhatsApp runner did not answer ${context.method} for instance ${context.instanceId} within ${context.timeoutMs}ms`,
      { status: 504, code: WHATSAPP_RPC_ERROR_CODES.timeout },
    );
  }
  if (code && NATS_CONNECTION_ERROR_CODES.has(code)) {
    return new OmniApiError(
      `NATS is not reachable, so the native WhatsApp runner cannot be called (is the ravi daemon running?): ${errorText(err)}`,
      { status: 503, code: WHATSAPP_RPC_ERROR_CODES.runnerUnavailable, details: code },
    );
  }
  return new OmniApiError(`Native WhatsApp RPC ${context.method} failed: ${errorText(err)}`, {
    status: 502,
    code: WHATSAPP_RPC_ERROR_CODES.transportError,
    details: code,
  });
}

function invalidResponse(method: WhatsAppRpcMethod, details: string): OmniApiError {
  return new OmniApiError(`Native WhatsApp runner returned an invalid response for ${method}`, {
    status: 502,
    code: WHATSAPP_RPC_INVALID_RESPONSE_CODE,
    details,
  });
}

/**
 * Call one native WhatsApp RPC method on the runner that owns `instanceId` (the
 * instance UUID). Params are validated with the contract schema before sending
 * (400 INVALID_REQUEST on failure); the `data` of a successful response is returned
 * as the contract's `WhatsAppRpcResult<M>`.
 */
export function requestWhatsAppRpc<M extends WhatsAppRpcMethod>(
  instanceId: string,
  method: M,
  params: WhatsAppRpcParams<M>,
  options: WhatsAppRpcRequestOptions = {},
): Promise<WhatsAppRpcResult<M>> {
  return requestWhatsAppRpcRaw(instanceId, method, params, options);
}

/**
 * Same as `requestWhatsAppRpc` for params that are only known at runtime (e.g. an
 * Omni-style JSON body). The params are validated against the contract schema here,
 * exactly as for the typed variant.
 */
export async function requestWhatsAppRpcRaw<M extends WhatsAppRpcMethod>(
  instanceId: string,
  method: M,
  params: unknown,
  options: WhatsAppRpcRequestOptions = {},
): Promise<WhatsAppRpcResult<M>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WHATSAPP_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(`Invalid WhatsApp RPC timeout: ${timeoutMs}`);
  }

  let subject: string;
  try {
    subject = whatsappRpcSubject(instanceId);
  } catch (err) {
    throw new OmniApiError(`Invalid WhatsApp instance id: ${instanceId}`, {
      status: 400,
      code: WHATSAPP_RPC_ERROR_CODES.invalidRequest,
      details: errorText(err),
    });
  }

  const parsedParams = WhatsAppRpcParamsSchemas[method].safeParse(params);
  if (!parsedParams.success) {
    throw new OmniApiError(`Invalid ${method} request: ${parsedParams.error.issues.map((i) => i.message).join("; ")}`, {
      status: 400,
      code: WHATSAPP_RPC_ERROR_CODES.invalidRequest,
      details: parsedParams.error.issues,
    });
  }

  const request: WhatsAppRpcRequest = {
    protocol: WHATSAPP_RPC_PROTOCOL,
    schemaVersion: WHATSAPP_RPC_SCHEMA_VERSION,
    requestId: randomUUID(),
    instanceId: instanceId.trim(),
    method,
    params: parsedParams.data,
  };

  let reply: { data: Uint8Array };
  try {
    const connection = options.connection ?? (await ensureConnected());
    reply = await connection.request(subject, codec.encode(request), { timeout: timeoutMs });
  } catch (err) {
    throw mapWhatsAppRpcTransportError(err, { instanceId, method, timeoutMs });
  }

  let decoded: unknown;
  try {
    decoded = codec.decode(reply.data);
  } catch (err) {
    throw invalidResponse(method, `undecodable payload: ${errorText(err)}`);
  }
  const parsed = WhatsAppRpcResponseSchema.safeParse(decoded);
  if (!parsed.success) throw invalidResponse(method, parsed.error.message);
  const response = parsed.data;
  if (response.requestId !== request.requestId) {
    throw invalidResponse(method, `requestId mismatch: expected ${request.requestId}, got ${response.requestId}`);
  }
  if (!response.ok) {
    throw new OmniApiError(response.error.message, { status: response.error.status, code: response.error.code });
  }
  if (response.data === null || typeof response.data !== "object") {
    throw invalidResponse(method, "data is not an object");
  }
  // The runner validates its own output against the contract; the client trusts the shape.
  return response.data as WhatsAppRpcResult<M>;
}
