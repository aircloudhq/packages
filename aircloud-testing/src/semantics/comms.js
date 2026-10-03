// @aircloudhq/testing — Air-Comms: mail and WhatsApp sends, recipient consent, suppression listing.
//
// Mirrored behaviour (production arm — the comms gateway, control-plane/internal/commsgw):
//   * mail: send.go validateSendRequest (non-empty `to`, html or text, the combined body cap, every
//     address an RFC 5322 addr-spec, the per-send recipient cap over the de-duplicated to∪cc∪bcc),
//     then pipeline.go: suppression (`comms.recipient_suppressed`, details.suppressed), then the
//     wallet under `comms.mail.send` for the recipient count (`comms.quota_exceeded`).
//   * WhatsApp: channel_whatsapp.go validateWhatsAppSendRequest (E.164 `to`, non-blank text, body
//     cap), suppression, per-tenant CONSENT (`comms.recipient_consent_absent`, details.unconsented),
//     then the wallet under `comms.whatsapp.send` for one unit.
//   * consent: control-plane/internal/api/consent.go — its codes are the httperr envelope's
//     (`bad_request`, `conflict`, `not_found`), passed through verbatim by the host.
// Non-production arm (functions/src/caps_comms.rs *_send_capture): no validation, no dial, the
// synthetic `message-id: "capture:<uuid>"`, and a capture record carrying mail recipient DOMAINS
// only, or `whatsapp:` and nothing after it.
//
// Sync: the two gateway caps below are a declared lockstep mirror of send.go's constants
// (recipientCap, bodyCap — Provisional there); send.go is the canonical carrier.
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";
import { admit } from "./quota.js";

const RECIPIENT_CAP = 50;
const BODY_CAP = 2 * 1024 * 1024;
const E164 = /^\+[1-9][0-9]{1,14}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// RFC 5322 addr-spec (dot-atom or quoted local part; dot-atom or literal domain), optionally in a
// `Display Name <addr-spec>` mailbox — the forms Go's net/mail.ParseAddress accepts.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const DOT_ATOM = `${ATEXT}(?:\\.${ATEXT})*`;
const ADDR_SPEC = `(?:${DOT_ATOM}|"(?:[^"\\\\]|\\\\.)*")@(?:${DOT_ATOM}|\\[[^\\[\\]\\\\]*\\])`;
const MAILBOX_RE = new RegExp(`^\\s*(?:(?:[^<>]*?)\\s*<(${ADDR_SPEC})>|(${ADDR_SPEC}))\\s*$`);

/** → the lower-cased addr-spec, or null when not a valid address. */
export function parseMailAddress(s) {
  const m = MAILBOX_RE.exec(s);
  if (!m) return null;
  return (m[1] || m[2]).toLowerCase();
}

function mailDomains(req) {
  const out = [];
  for (const a of [...req.to, ...req.cc, ...req.bcc]) {
    const i = a.lastIndexOf("@");
    if (i < 0) continue;
    const d = a.slice(i + 1).trim().toLowerCase();
    if (d && !out.includes(d)) out.push(d);
  }
  return `mail:${out.join(",")}`;
}

const httperr = (code, message) => new CapabilityFailure(code, message, {});

export function createCommsState(world) {
  const sent = { mail: [], whatsapp: [] };
  const captures = [];
  const suppressions = [];
  const consents = [];

  function suppressedAmong(channel, addresses) {
    return addresses.filter((a) => suppressions.some((s) => s.channel === channel && s.address === a));
  }
  function activeConsent(channel, address) {
    const now = world.clock.nowMs();
    return consents.find((c) => c.channel === channel && c.address === address && c.revokedAt === null
      && (c.expiresAt === null || Date.parse(c.expiresAt) > now));
  }
  function view(c) {
    return {
      consentId: c.consentId, orgPath: c.orgPath, channel: c.channel, address: c.address, basis: "builder_asserted",
      source: c.source ?? "", grantedAt: c.grantedAt, expiresAt: c.expiresAt ?? "", revokedAt: c.revokedAt ?? "",
      revokedReason: c.revokedReason ?? "", assertedBy: c.assertedBy, recordedAt: c.recordedAt,
    };
  }
  function nowRfc3339() {
    return new Date(Math.floor(world.clock.nowMs() / 1000) * 1000).toISOString().replace(".000Z", "Z");
  }
  function capture(capability, destination) {
    const captureId = world.newId();
    captures.push({ captureId, capability, destination, method: "SEND" });
    return { messageId: `capture:${captureId}` };
  }

  const state = {
    get sent() { return sent; },
    get captures() { return captures; },
    /** Put an address on the suppression list (the tenant's own-origin listing). */
    suppress(channel, address, { reason = "hard_bounce", originRail = "platform", createdAt } = {}) {
      if (typeof channel !== "string" || typeof address !== "string") throw new DoubleMisuseError("comms.suppress(channel, address)");
      suppressions.push({ channel, address: channel === "mail" ? address.toLowerCase() : address, reason, originRail, createdAt: createdAt ?? nowRfc3339() });
    },
    /** Record consent as the Builder would (the same path as the guest's grant). */
    consent(channel, address, opts = {}) {
      return state.grant({ channel, address, source: opts.source, expiresAt: opts.expiresAt });
    },
    /** The asserting subject minted onto consent rows (the function's verified identity). */
    assertedBy: "service:function",

    // ── the WIT surface ──────────────────────────────────────────────────────────────────
    sendMail(req) {
      if (world.linkArm("comms.mail.send") === "capture") return capture("comms.mail.send", mailDomains(req));
      if (req.to.length === 0) throw new CapabilityFailure("comms.validation", "to must be non-empty", {});
      const html = req.html ?? "";
      const text = req.text ?? "";
      if (html === "" && text === "") throw new CapabilityFailure("comms.validation", "at least one of html or text is required", {});
      if (Buffer.byteLength(html) + Buffer.byteLength(text) > BODY_CAP) {
        throw new CapabilityFailure("comms.validation", "combined html+text exceeds the body size cap", {});
      }
      const bad = [];
      const recips = [];
      for (const a of [...req.to, ...req.cc, ...req.bcc]) {
        const norm = parseMailAddress(a);
        if (norm === null) { bad.push(a); continue; }
        if (!recips.includes(norm)) recips.push(norm);
      }
      if (req.replyTo && parseMailAddress(req.replyTo) === null) bad.push(req.replyTo);
      if (bad.length > 0) throw new CapabilityFailure("comms.validation", "one or more addresses are not valid addr-spec", { invalid: bad });
      if (recips.length > RECIPIENT_CAP) {
        throw new CapabilityFailure("comms.validation", "total recipients exceed the per-send cap", { recipient_count: recips.length, cap: RECIPIENT_CAP });
      }
      const suppressed = suppressedAmong("mail", recips);
      if (suppressed.length > 0) {
        throw new CapabilityFailure("comms.recipient_suppressed", "one or more recipients are on the suppression list", { suppressed });
      }
      admit(world, "comms.mail.send", recips.length, "comms");
      const messageId = world.newId();
      sent.mail.push({ messageId, recipients: recips, ...req });
      return { messageId };
    },
    sendWhatsapp(req) {
      if (world.linkArm("comms.whatsapp.send") === "capture") return capture("comms.whatsapp.send", "whatsapp:");
      if (!E164.test(req.to)) {
        throw new CapabilityFailure("comms.validation", "to must be an E.164 phone number in international form, e.g. +5511987650001", { field: "to" });
      }
      if (req.text.trim() === "") throw new CapabilityFailure("comms.validation", "text must be a non-empty message body", { field: "text" });
      if (Buffer.byteLength(req.text) > BODY_CAP) {
        throw new CapabilityFailure("comms.validation", "text exceeds the body size cap", { field: "text", cap: BODY_CAP });
      }
      const suppressed = suppressedAmong("whatsapp", [req.to]);
      if (suppressed.length > 0) {
        throw new CapabilityFailure("comms.recipient_suppressed", "one or more recipients are on the suppression list", { suppressed });
      }
      if (!activeConsent("whatsapp", req.to)) {
        throw new CapabilityFailure("comms.recipient_consent_absent", "this recipient has not given you consent to be messaged on WhatsApp", { unconsented: [req.to] });
      }
      admit(world, "comms.whatsapp.send", 1, "comms");
      const messageId = world.newId();
      sent.whatsapp.push({ messageId, ...req });
      return { messageId };
    },
    grant(req) {
      if ((req.channel ?? "").trim() === "" || (req.address ?? "").trim() === "") {
        throw httperr("bad_request", "channel and address are required");
      }
      if (req.expiresAt !== undefined && req.expiresAt.trim() !== "" && !RFC3339.test(req.expiresAt)) {
        throw httperr("bad_request", "expires_at must be an RFC3339 timestamp");
      }
      if (activeConsent(req.channel, req.address)) {
        throw httperr("conflict", "an active consent already exists for this channel and address");
      }
      const t = nowRfc3339();
      const row = {
        consentId: world.newId(), orgPath: "/", channel: req.channel, address: req.address,
        source: req.source ? req.source : null,
        expiresAt: req.expiresAt && req.expiresAt.trim() !== "" ? new Date(Date.parse(req.expiresAt)).toISOString().replace(".000Z", "Z") : null,
        grantedAt: t, recordedAt: t, revokedAt: null, revokedReason: null, assertedBy: state.assertedBy,
      };
      consents.push(row);
      return view(row);
    },
    revoke(req) {
      if ((req.channel ?? "").trim() === "" || (req.address ?? "").trim() === "") {
        throw httperr("bad_request", "channel and address are required");
      }
      if ((req.reason ?? "").trim() === "") {
        throw httperr("bad_request", "reason is required — a revocation without one is unauditable, and the schema refuses it too");
      }
      const row = activeConsent(req.channel, req.address);
      if (!row) throw httperr("not_found", "no active consent for this channel and address");
      row.revokedAt = nowRfc3339();
      row.revokedReason = req.reason;
    },
    listConsents() {
      return { consents: consents.map(view) };
    },
    listSuppressions() {
      return { suppressions: suppressions.map((s) => ({ channel: s.channel, address: s.address, reason: s.reason, originRail: s.originRail, createdAt: s.createdAt })) };
    },
  };
  return state;
}

// The httperr codes the consent routes answer with (control-plane/internal/api/consent.go). They
// are not in any errors contract; this list is the double's declared mirror of that handler.
export const CONSENT_HTTPERR_CODES = ["bad_request", "conflict", "not_found"];
