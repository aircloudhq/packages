// @aircloudhq/testing — the release's entries, and the acting node each resolves to (#384 D66; ADR-295
// decision 1; functions/src/acting_node.rs, invoke.rs, admission.rs `trigger_acting`).
//
// On the platform a function runs only through an entry its release declares, and the functions-host
// resolves the node it acts at BEFORE the guest runs, never by default:
//
//   entry                       descriptor                                   acting (entry) node
//   a function [[route]]        { route: "<prefix>" }                        a PUBLIC route: its declared org_path,
//                                                                            and no principal whoever is signed in;
//                                                                            an AUTHENTICATED route: the session's
//                                                                            membership home (no session: the
//                                                                            web-origin's session_required; a route
//                                                                            narrowed to roles none of which is
//                                                                            effective — at the home, or at its
//                                                                            `at` node or below — the web-origin's
//                                                                            session_role_required)
//   a [[triggers.events]] entry { function, event: "<topic>", source?, entity? }  the trigger's declared org_path
//   a [[triggers.cron]] entry   { function, cron: "<schedule>" }              the trigger's declared org_path
//   a direct invoke             { function, orgPath? }                        the caller's home — the Builder's,
//                                                                            `/` — or `orgPath` at or below it
//
// A route or trigger the release does not declare, or one that declares no org_path, is refused with
// functions.org_path_undeclared (409, details.entry) without invoking: the host never reads absence as '/'.
// A node that is archived refuses with functions.org_node_archived. Each refusal is the host's answer to the
// caller — invoke() resolves to its envelope, the guest never runs. An event, a cron and a direct invoke
// serve no end user, whoever the test signed in, and so does a public route (the host carries no principal
// there, #384 D72); an authenticated route serves the signed-in one.
//
// An invocation's elevated aggregates are its function's own `[[elevate]]` declarations, which the model carries
// beside the function (the release model's, functions/src/release_model.rs); a test never declares them.
//
// THE MODEL. `aircloud test prepare` compiles the release's entries (generate.CompileEntryModel) to
// .aircloud/entries.json — app/site/.aircloud/entries.json in a product with a site — beside the compiled
// schema; invoke() reads it from the product the working directory is in, and loads each function from the
// module it names. `world.entries.use(model, root)` hands the double another model, its modules resolved
// against `root`. The double never declares an entry itself: the release is the one carrier.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DoubleMisuseError } from "../errors.js";
import { validOrgPath } from "./acting-node.js";
import { atOrBelow, AuthzRefusal, nodeChain } from "./authz.js";
import { PRODUCT_SCHEMA_WRITER, PRODUCT_SITE_DIR, productRoot } from "./i18n.js";
import { routeAdmits } from "./principal.js";

/**
 * The entry model's paths, relative to the product root: beside the compiled schema (generate.EntryModelFile;
 * literal mirrors held equal by generate.TestEntryModelFileIsTheDoublesPath), placed by whether app/site/
 * exists — the other path is never a fallback.
 */
export const PRODUCT_ENTRIES_FILE = "app/site/.aircloud/entries.json";
export const API_PRODUCT_ENTRIES_FILE = ".aircloud/entries.json";
/** == generate.EntryModelVersion: the one shape this double reads. */
const ENTRY_MODEL_VERSION = 1;

/** == functions/src/acting_node.rs: the Builder member's home, the caller of a direct invoke. */
const BUILDER_HOME = "/";

/** The entry-model file a product at `root` reads, relative to it. */
export function productEntriesFile(root) {
  return existsSync(join(root, PRODUCT_SITE_DIR)) ? PRODUCT_ENTRIES_FILE : API_PRODUCT_ENTRIES_FILE;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function checkModel(model, where) {
  const bad = (m) => new DoubleMisuseError(`${where}: ${m} — rerun \`${PRODUCT_SCHEMA_WRITER}\``);
  if (!isObj(model)) throw bad("not an entry model");
  if (model.version !== ENTRY_MODEL_VERSION) {
    throw bad(`entry model version ${JSON.stringify(model.version)}, this double reads version ${ENTRY_MODEL_VERSION}`);
  }
  if (!isObj(model.functions) || !["routes", "events", "cron"].every((k) => Array.isArray(model[k]))) {
    throw bad("an entry model carries functions, routes, events and cron");
  }
  for (const [name, f] of Object.entries(model.functions)) {
    if (isObj(f) && f.elevate !== undefined && !(Array.isArray(f.elevate) && f.elevate.every(isObj))) {
      throw bad(`function ${name}'s elevate is not a list of declarations`);
    }
  }
  return model;
}

/** A refusal the host answers before the guest runs: {status, code, message, details}. */
function refusal(status, code, message, details = {}) {
  return { refusal: { status, code, message, details } };
}

function undeclared(entry, why) {
  return refusal(409, "functions.org_path_undeclared",
    `the active release declares no org_path for this ${entry} entry${why ? ` (${why})` : ""} — the host never acts at '/' by default`, { entry });
}

/** == guest_path (functions/src/invoke.rs): the path the guest receives, or null when the prefix does not serve it. */
function guestPath(original, prefix, strip) {
  if (!original.startsWith(prefix)) return null;
  const rest = original.slice(prefix.length);
  if (rest !== "" && !rest.startsWith("/")) return null;
  if (!strip) return original;
  return rest === "" ? "/" : rest;
}

const DESCRIPTOR_KEYS = {
  route: ["route"],
  event: ["function", "event", "source", "entity"],
  cron: ["function", "cron"],
  direct: ["function", "orgPath"],
};

/** Which entry `d` names, or a misuse naming the descriptor shapes. */
function descriptorKind(d) {
  const shapes = "{ route: prefix }, { function, event: topic, source?, entity? }, { function, cron: schedule } or { function, orgPath? }";
  if (!isObj(d)) throw new DoubleMisuseError(`invoke(entry, request): entry names a declared entry — ${shapes}`);
  const kind = "route" in d ? "route" : "event" in d ? "event" : "cron" in d ? "cron" : "function" in d ? "direct" : null;
  const extra = kind && Object.keys(d).find((k) => !DESCRIPTOR_KEYS[kind].includes(k));
  if (!kind || extra !== undefined) {
    throw new DoubleMisuseError(`invoke(entry, request): ${JSON.stringify(d)} is not one entry — ${shapes}`);
  }
  if (kind !== "route" && typeof d.function !== "string") throw new DoubleMisuseError(`invoke: a ${kind} entry names its function`);
  return kind;
}

export function createEntriesState(w) {
  let handed = null; // {model, root}
  const load = () => {
    if (handed) return handed;
    const root = productRoot(process.cwd());
    if (root === null) {
      throw new DoubleMisuseError("invoke: not inside a product (no aircloud.toml at or above the working directory) — or hand the entries with world.entries.use(model, root)");
    }
    const rel = productEntriesFile(root);
    const file = join(root, rel);
    if (!existsSync(file)) {
      throw new DoubleMisuseError(`invoke: no entry model at ${rel} — run \`${PRODUCT_SCHEMA_WRITER}\` in the product (npm test's pretest and \`aircloud test\` run it)`);
    }
    let model;
    try {
      model = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new DoubleMisuseError(`invoke: ${rel} is not JSON (${e.message}) — rerun \`${PRODUCT_SCHEMA_WRITER}\``);
    }
    return { model: checkModel(model, `invoke: ${rel}`), root };
  };

  /** The node `p` the invocation would act at, proven active (the host's check_active), or its refusal. */
  const active = (p) => {
    w.projection.ensure(p);
    try {
      nodeChain(w.projection.view(), p);
      return null;
    } catch (e) {
      if (!(e instanceof AuthzRefusal)) throw e;
      return refusal(409, "functions.org_node_archived", `the node ${p} is archived or cannot be proven active: nothing acts there`, { org_path: p });
    }
  };

  /** A declared node, as acting_node.rs `declared`: absent or outside the grammar is undeclared. */
  const declared = (entry, orgPath) => {
    if (orgPath === undefined || orgPath === null) return undeclared(entry);
    if (!validOrgPath(orgPath)) return undeclared(entry, `${JSON.stringify(orgPath)} is not a node`);
    return active(orgPath) ?? { entry: orgPath };
  };

  const state = {
    /** Hand the double an entry model ({version, functions, routes, events, cron}), its modules under `root`. */
    use(model, root) {
      if (typeof root !== "string" || !isAbsolute(root)) throw new DoubleMisuseError("entries.use(model, root): root is an absolute directory");
      handed = { model: checkModel(model, "entries.use"), root };
    },
    /**
     * Resolve the entry `d` names for `request`, as the host does before the guest runs: either
     * {refusal: {status, code, message, details}} — the host's answer, the guest never runs — or
     * {module, request, frame: {entry, acting, session}}.
     */
    async resolve(d, request) {
      const kind = descriptorKind(d);
      const { model, root } = load();
      let resolved;
      let fn;
      let guest = request;
      if (kind === "route") {
        const r = model.routes.find((x) => x.prefix === d.route);
        if (!r) return undeclared("route", `no function [[route]] at ${JSON.stringify(d.route)}`);
        const url = new URL(request.url);
        const path = guestPath(url.pathname, r.prefix, r.strip_prefix);
        if (path === null) throw new DoubleMisuseError(`invoke: the [[route]] at ${r.prefix} does not serve ${url.pathname}`);
        fn = r.function;
        if (r.authenticated) {
          const session = w.principal.session();
          if (!session) {
            return refusal(401, "session_required", `the route ${r.prefix} is a session route, and the request carries no end-user session (world.principal.signIn)`);
          }
          // The web-origin's route-role gate, before the host is reached (web-origin/src/route_roles.rs).
          if (!routeAdmits(w.principal, r.roles ?? [], r.at)) {
            return refusal(403, "session_role_required",
              `the session holds none of the roles the route ${r.prefix} is narrowed to (${(r.roles ?? []).join(", ")})${r.at ? ` at ${r.at} or below` : " at its membership's home"}`);
          }
          // The signed-in end user is the route's: the invocation acts at the selected membership's home.
          resolved = { entry: session.home, session: true };
        } else {
          // A public route carries no principal, whoever is signed in (functions/src/invoke.rs): it acts at
          // the node the route declares.
          resolved = { ...declared("route", r.org_path), session: false };
        }
        if (path !== url.pathname) {
          url.pathname = path;
          const hasBody = request.method !== "GET" && request.method !== "HEAD";
          guest = new Request(url, { method: request.method, headers: request.headers, body: hasBody ? await request.arrayBuffer() : undefined });
        }
      } else if (kind === "direct") {
        fn = d.function;
        if (!Object.hasOwn(model.functions, fn)) return refusal(404, "functions.not_found", `the release holds no function ${fn}`);
        const p = d.orgPath ?? BUILDER_HOME;
        if (!validOrgPath(p)) return refusal(400, "functions.validation", `x-air-invoke-org-path is not an org node: ${JSON.stringify(p)}`);
        if (!atOrBelow(p, BUILDER_HOME)) {
          return refusal(403, "functions.forbidden", `the requested org_path ${p} is not at or below the caller's node ${BUILDER_HOME}`);
        }
        resolved = { ...(active(p) ?? { entry: p }), session: false };
      } else {
        fn = d.function;
        const list = kind === "event"
          ? model.events.filter((t) => t.function === fn && t.topic === d.event && (d.source === undefined || t.source === d.source) && (d.entity === undefined || t.entity === d.entity))
          : model.cron.filter((t) => t.function === fn && t.schedule === d.cron);
        if (list.length > 1) {
          throw new DoubleMisuseError(`invoke: ${JSON.stringify(d)} matches ${list.length} [[triggers.${kind === "event" ? "events" : "cron"}]] entries of ${fn} — name its source or entity`);
        }
        if (list.length === 0) return undeclared(kind, `${fn} declares no such trigger`);
        resolved = { ...declared(kind, list[0].org_path), session: false };
      }
      if (resolved.refusal) return { refusal: resolved.refusal };
      const f = model.functions[fn];
      if (!f) throw new DoubleMisuseError(`invoke: the entry model names function ${fn}, which it does not hold — rerun \`${PRODUCT_SCHEMA_WRITER}\``);
      if (f.runtime !== "js") {
        throw new DoubleMisuseError(`invoke: ${fn} is a ${f.runtime} function — its unit tests run under cargo test, not this double`);
      }
      // The function's own [[elevate]] declarations, as the release model carries them to the host
      // (functions/src/release_model.rs): the only ones an aggregate-elevated call of this invocation stays inside.
      const elevate = (f.elevate ?? []).map((d) => ({ ...d, function: fn }));
      return { module: join(root, f.module), request: guest, frame: { entry: resolved.entry, acting: null, session: resolved.session, elevate } };
    },
  };
  return state;
}
