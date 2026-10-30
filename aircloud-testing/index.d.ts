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

export type DenyOp = "entity.read" | "entity.create" | "entity.update" | "entity.delete";

/** A membership in the authority projection's shape (contracts/auth/v1/authz-projection.json). */
export interface Membership {
  id: string;
  home: string;
  home_roles?: string[];
  scopes?: string[];
  grants?: Array<{ org_path: string; roles: string[]; exp?: string | null; via_group?: { org_path: string; name: string } | null }>;
  denies?: Array<{ org_path: string; roles: string[]; ops: DenyOp[]; entity: string | null }>;
}

/**
 * A test principal's grant (test/principals.toml `grants`, ADR-262; ADR-293 decision 3): the base profile
 * `profile` of config/profiles.toml, with the `roles` it holds, effective at `node` and below until `expires`.
 */
export interface TestPrincipalGrant {
  node: string;
  profile: string;
  roles: string[];
  expires?: string;
}

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
  /**
   * The tenant's authority projection (ADR-293): node keys and principal keys — the ONE source of every
   * role, node and deny the double's Flex and principal surfaces read. A node the test names (a membership
   * home, an entered node, a declared one) exists, active, with its ancestors; any other node has no key and
   * is refused as unknown. The runtime's service account (`function-runtime`) sits at `/` by default.
   */
  projection: {
    node(path: string, key?: { status?: "active" | "archived"; denies?: Array<{ roles: string[]; ops: DenyOp[]; entity: string | null }> }): void;
    deny(deny: { org_path: string; roles: string[]; ops: DenyOp[]; entity?: string | null }): void;
    endUser(sub: string, memberships: Membership[]): void;
    serviceAccount(sub: string, home: string, scopes?: string[]): void;
    builder(sub: string, scopes?: string[]): void;
    principal(sub: string, value: { plane: "builder" | "end_user" | "service"; kind: string; memberships: Membership[] }): void;
    ensure(path: string): void;
  };
  principal: {
    /**
     * Serve a `session` route for `sub`: `{ orgPath, roles, grants }` is one membership homed at `orgPath`
     * (default `/`) holding `roles` there and each grant — a base profile (its `roles`) held at `node`, at or
     * below the home, until `expires` (RFC 3339; absent: never) — test/principals.toml's shape;
     * `{ memberships, membership }` the end user's memberships and the one the session selected. Either places
     * the end user's projection key.
     */
    signIn(session: {
      sub: string; tenantId?: string; act?: unknown; flash?: string; csrf?: string;
    } & ({ orgPath?: string; roles?: string[]; grants?: TestPrincipalGrant[] } | { memberships: Membership[]; membership?: string })): void;
    signOut(): void;
    readonly flashOut: string | null;
  };
  actingNode: {
    /**
     * The entry node of a capability called directly, outside `invoke` — there is no default. An invocation
     * resolves its own from the entry it goes through.
     */
    enter(orgPath: string): void;
    /**
     * The `[[elevate]]` declarations of a capability called directly, outside `invoke`. An invocation checks
     * against its function's own, read from the release's entry model (function.toml), never these.
     */
    declareElevate(decls: Array<{ function?: string; entity: string; ops: string[]; filter: string[]; group_by: string[]; fields: string[]; scope: "node" | "subtree" }>): void;
  };
  entries: {
    /**
     * Hand the double an entry model in place of the product's (`aircloud test prepare` writes that one to
     * .aircloud/entries.json): each function's runtime and module (a path from `root`), and the release's
     * function routes, event triggers and crons with the org_path each declares.
     */
    use(model: EntryModel, root: string): void;
  };
  flex: {
    /**
     * The bearer the function's Flex calls carry — the runtime's service account by default; identity only
     * (its node and authority are its projection key's). A signed-in end user rides it as the host's
     * end_user assertion, an entered node as a node assertion (ADR-295).
     */
    bearer: { plane: "service" | "end_user" | "internal" | "builder"; sub: string; org_path?: string; membership?: string };
    /**
     * The surface the invocation's entry serves (ADR-294 decision 1), `api` by default. It rides the host's
     * assertion, the only place Flex reads it (#384 D82): a call carrying none is `api`.
     */
    surface: "api" | "mcp" | "ui.form" | "ui.table" | "import";
    /** Publish a field-policy overlay at a node strictly below `/` (ADR-294 decision 3). */
    publishOverlay(overlay: { at: string; entity: string; policy: Array<{ field: string; effect: "visible" | "writable" | "required"; when: unknown }> }): void;
    /** Run `fn` with its Flex calls signed as one declared elevated aggregate call (ADR-295 decision 8). */
    underElevation<T>(declaration: { function?: string; entity: string; ops: string[]; filter: string[]; group_by: string[]; fields: string[]; scope: "node" | "subtree" }, fn: () => T): T;
    /**
     * Converge the base layer as PUT /v1/schema does: the declaration db/schema/*.toml compiles to (owner,
     * owner_bypass_roles, shared; write_roles — ADR-279; an enum's values and removed_values — ADR-258; a field's tagged default
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
        write_roles?: { create?: string[] | null; update?: string[] | null; delete?: string[] | null } | null;
        fields?: Record<string, {
          type: string; display_name?: string | null; required?: boolean | null; removed?: boolean | null;
          target?: string | null; dims?: number | null; values?: string[] | null; removed_values?: string[] | null;
          default?: { value: unknown } | { generator: "now" | "today" } | null;
        }> | null;
      }>;
    }): { applied: Array<{ op: string; entity: string; field?: string }> };
    /**
     * Converge the base layer to the product's compiled schema — db/schema/*.toml as `aircloud test prepare`
     * writes it (the release's tests part mounts the release's own) — read from the product the working
     * directory sits in. Every schema entity sits at `/`, whatever node a test signed in at; owner,
     * owner_bypass_roles, shared, write_roles and defaults are the declared ones. What a generated test calls after
     * `world.reset()`. `testEntities` declares test-only entities beside the schema's, in the same base
     * layer; a name the schema declares is refused.
     */
    declareFromSchema(testEntities?: Record<string, { display_name?: string | null; fields?: Record<string, { type: string; required?: boolean | null; [key: string]: unknown }> | null }>): { applied: Array<{ op: string; entity: string; field?: string }> };
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

/** The release's entries, as `aircloud test prepare` compiles them (generate.CompileEntryModel). */
export interface EntryModel {
  version: 1;
  functions: Record<string, { runtime: string; module: string }>;
  routes: Array<{ prefix: string; function: string; authenticated: boolean; strip_prefix: boolean; org_path?: string }>;
  events: Array<{ function: string; topic: string; source: string; entity?: string; org_path?: string }>;
  cron: Array<{ function: string; schedule: string; org_path?: string }>;
}

/**
 * A declared entry of the release (#384, ADR-295 decision 1): a function [[route]] by its prefix, an event or
 * cron trigger of a function, or a direct invoke — the Builder's, at its home `/` or at `orgPath` below it.
 */
export type Entry =
  | { route: string }
  | { function: string; event: string; source?: string; entity?: string }
  | { function: string; cron: string }
  | { function: string; orgPath?: string };

/** The one world the generated capability bindings read and write. */
export const world: World;

/**
 * Invoke the function behind the declared `entry` with `request`, instantiating the guest fresh. The
 * invocation acts at the node the platform resolves for the entry — a route's or a trigger's declared
 * org_path, an authenticated route's session home, a direct invoke's caller node — and an entry the release
 * does not declare, or that declares no org_path, resolves to the platform's refusal (409
 * functions.org_path_undeclared) without running the guest. The invocation's correlation id is the
 * request's `x-correlation-id` when it is a UUID, otherwise a fresh one: the guest's request carries it
 * under that header, and every capability call of the invocation carries it.
 */
export function invoke(entry: Entry, request: Request | string): Promise<Response>;
