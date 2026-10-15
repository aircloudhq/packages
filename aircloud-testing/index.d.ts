// @aircloudhq/testing — the test-author API. The capability functions themselves are typed by the
// generated declarations under ./generated/bindings (import them as a guest does, or through
// "@aircloudhq/testing/capability/<interface>").
import type { CapTypes } from "./generated/types.js";

/** Thrown by a capability call that the platform refuses: `payload` is the error-envelope. */
export class ComponentError extends Error {
  readonly payload: CapTypes.ErrorEnvelope;
}

/** Thrown when a test asks the double for something it cannot answer truthfully. */
export class DoubleMisuseError extends Error {}

export interface CapabilityCall {
  interface: string;
  function: string;
  capability: string;
  args: unknown[];
  correlationId: string;
  environment: string;
  outcome?: { ok: true } | { error: string };
}

export interface EgressRequest {
  handle: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EgressReply {
  status: number;
  headers?: Record<string, string> | Array<[string, string]>;
  body?: string;
}

export type Policy = "hard_block" | "allow_overage" | "warn_upgrade";

export interface World {
  /** Fresh state: call in beforeEach. */
  reset(): World;
  /** `production` (default) or any other environment name — outside production, external `capture` capabilities capture. */
  environment: string;
  readonly calls: CapabilityCall[];
  clock: {
    now(): Date;
    set(instant: Date | string | number | null): void;
    advance(ms: number): void;
  };
  faults: {
    inject(target: string, envelope: { code: string; message?: string; details?: unknown }, opts?: { times?: number }): void;
    pending(): Array<{ target: string; code: string; left: number }>;
    clear(): void;
  };
  linkArm(capability: string): "real" | "capture" | "deny" | "test-mode";
  flex: {
    /**
     * The bearer the function's Flex calls carry — the runtime's service account at `/` by default. A
     * signed-in end user (`world.principal.signIn`) rides it as the host's assertion; the session runs at
     * that end user's node and, on an entity declaring `owner`, sees only what it owns (ADR-257).
     */
    bearer: { plane: "service" | "end_user" | "internal" | "builder"; sub: string; roles: string[] | null; org_path: string };
    /**
     * Converge the base layer as PUT /v1/schema does: the declaration db/schema/*.toml compiles to (owner,
     * owner_bypass_roles, shared; an enum's values and removed_values — ADR-258; a field's tagged default
     * and the product time zone with its locale-bundle rules — ADR-259, both zone keys required). Returns
     * the update ops it applied to live fields (`update_enum_values`, `update_default`).
     */
    declare(declaration: {
      time_zone: string;
      time_zone_rules: { initial: object; transitions: object[]; rule: object | null };
      entities: Record<string, {
        display_name?: string | null;
        owner?: string | null;
        owner_bypass_roles?: string[] | null;
        shared?: boolean | null;
        fields?: Record<string, {
          type: string; display_name?: string | null; required?: boolean | null; removed?: boolean | null;
          target?: string | null; dims?: number | null; values?: string[] | null; removed_values?: string[] | null;
          default?: { value: unknown } | { generator: "now" | "today" } | null;
        }> | null;
      }>;
    }): { applied: Array<{ op: string; entity: string; field?: string }> };
    /** The seed surface (PUT …/records/by-key/{key}); refused for an acting end user. */
    upsertByKey(entity: string, key: string, data: Record<string, unknown>): { created: boolean; record: { id: string; data: Record<string, unknown> } };
    /** How many relation edges the current session sees pointing to, or leaving, a record. */
    edges(endpoint: { to: string } | { from: string }): number;
    defineEntity(spec: { name: string; display_name?: string; fields: Array<{ name: string; type: string; display_name?: string; required?: boolean; config?: object }> }): any;
    insert(entity: string, data: Record<string, unknown>): { id: string; data: Record<string, unknown> };
    records(entity: string): Array<{ id: string; data: Record<string, unknown> }>;
    entityNames(): string[];
  };
  quota: {
    set(meter: string, pool: { balance: number | bigint; limit?: number; policy?: Policy; grain?: string; retryAfterSeconds?: number }): void;
    unprovisioned(meter: string, opts?: { limit?: number; policy?: Policy; grain?: string; retryAfterSeconds?: number }): void;
    balance(meter: string): bigint | undefined;
  };
  credential: {
    define(handle: string, spec:
      | { type: "bearer"; secret: string; allow?: string[] }
      | { type: "basic"; secret: { username: string; password: string }; allow?: string[] }
      | { type: "header"; secret: string; header: string; allow?: string[] }
      | { type: "hmac"; secret: string }): void;
    revoke(handle: string): void;
    respond(match: string | ((req: EgressRequest) => boolean), reply: EgressReply | ((req: EgressRequest) => EgressReply)): void;
    readonly calls: EgressRequest[];
    readonly captures: Array<{ captureId: string; capability: string; destination: string; method: string }>;
    hmacSign(handle: string, algorithm: "sha256" | "sha512", message: Uint8Array): Uint8Array;
    hmacVerify(handle: string, algorithm: "sha256" | "sha512", message: Uint8Array, signature: Uint8Array): boolean;
  };
  bus: {
    readonly published: Array<{ eventId: string; topic: string; payload: unknown; environment: string }>;
    payloads(topic: string): unknown[];
  };
  comms: {
    readonly sent: { mail: any[]; whatsapp: any[] };
    readonly captures: Array<{ captureId: string; capability: string; destination: string; method: string }>;
    suppress(channel: string, address: string, opts?: { reason?: string; originRail?: string; createdAt?: string }): void;
    consent(channel: string, address: string, opts?: { source?: string; expiresAt?: string }): unknown;
    assertedBy: string;
  };
}

/** The one world the generated capability bindings read and write. */
export const world: World;

/**
 * Invoke a function's fetch listener with `request`, instantiating the guest fresh. The invocation's
 * correlation id is the request's `x-correlation-id` when it is a UUID, otherwise a fresh one: the
 * guest's request carries it under that header, and every capability call of the invocation carries it.
 */
export function invoke(entry: string | URL, request: Request | string): Promise<Response>;
