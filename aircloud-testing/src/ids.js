// @aircloudhq/testing — UUIDv7 minting on the world's clock.
//
// The platform mints every record, entity, field and event id as a UUIDv7 (flex/src/ids.rs
// ID_REGEX; the functions host new_id). An invocation's correlation id is not one of them: the
// host's entry surface resolves it (src/correlation.js). Ids here are v7 as well, and STRICTLY
// increasing within a world — the flex keyset order ties on id, so a double whose ids were not
// monotonic would page differently from the chokepoint.
import { randomBytes } from "node:crypto";

export const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createIdSource(clock) {
  let lastMs = -1;
  let counter = 0;
  return function newId() {
    let ms = clock.nowMs();
    if (ms <= lastMs) {
      ms = lastMs;
      counter++;
      if (counter > 0xfff) {
        // 4096 ids in one millisecond: borrow the next millisecond rather than repeat an id.
        ms = lastMs + 1;
        counter = 0;
      }
    } else {
      counter = 0;
    }
    lastMs = ms;
    const rnd = randomBytes(8);
    const hex = ms.toString(16).padStart(12, "0");
    const randA = (0x7000 | counter).toString(16);
    const variant = ((rnd[0] & 0x3f) | 0x80).toString(16).padStart(2, "0");
    const tail = rnd.subarray(1, 8).toString("hex").slice(0, 14);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${randA}-${variant}${tail.slice(0, 2)}-${tail.slice(2, 14)}`;
  };
}
