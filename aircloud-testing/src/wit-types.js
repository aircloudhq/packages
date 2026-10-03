// @aircloudhq/testing — the jco JavaScript representation of WIT values, checked.
//
// A guest's argument crosses the component boundary through jco's LOWERING, which refuses a value
// of the wrong shape with a TypeError before the host ever sees it. The double reproduces that
// refusal, so a guest that passes `{ topic: 1 }` fails here the way it fails in the component —
// not later, inside a semantics implementation that would have to guess.
//
// The representation (jco / componentize-js, the versions.json pins):
//   bool → boolean · string → string · char → one code point
//   u8…u32, s8…s32, f32, f64 → number · u64, s64 → bigint
//   list<u8> → Uint8Array · list<T> → Array · tuple → Array of fixed length
//   option<T> → T | undefined (null accepted on lowering) · record → object, lowerCamelCase keys
//   enum → the case name string (kebab-case) · variant → { tag, val } · result<T, E> → returns T,
//   throws ComponentError(E)
//
// The same checker validates what the double RETURNS (direction "lift"): a semantics bug that would
// hand a guest a shape the real binding never produces is refused as a double defect.

const INT_RANGES = {
  u8: [0, 0xff], u16: [0, 0xffff], u32: [0, 0xffffffff],
  s8: [-0x80, 0x7f], s16: [-0x8000, 0x7fff], s32: [-0x80000000, 0x7fffffff],
};
const BIG_RANGES = {
  u64: [0n, 0xffffffffffffffffn],
  s64: [-0x8000000000000000n, 0x7fffffffffffffffn],
};

/** kebab-case → lowerCamelCase, the jco identifier mapping. */
export function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** kebab-case → UpperCamelCase (type names in the generated declarations). */
export function pascal(name) {
  const c = camel(name);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

export function lookupType(model, iface, name) {
  const i = model.interfaces.find((x) => x.name === iface);
  const t = i && i.types[name];
  if (!t) throw new Error(`@aircloudhq/testing: type ${iface}.${name} is not in the WIT model`);
  return t;
}

/**
 * Check `value` against WIT type `type`. Returns the NORMALIZED value (option null → undefined,
 * an ArrayBuffer view → Uint8Array). Throws `fault(message)` on mismatch.
 */
export function checkValue(model, type, value, path, fault) {
  switch (type.kind) {
    case "prim": return checkPrim(type.name, value, path, fault);
    case "list": {
      if (type.of.kind === "prim" && type.of.name === "u8") {
        if (value instanceof Uint8Array) return value;
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        throw fault(`${path}: expected a Uint8Array (list<u8>)`);
      }
      if (!Array.isArray(value)) throw fault(`${path}: expected an array`);
      return value.map((v, i) => checkValue(model, type.of, v, `${path}[${i}]`, fault));
    }
    case "option":
      if (value === undefined || value === null) return undefined;
      return checkValue(model, type.of, value, path, fault);
    case "tuple": {
      if (!Array.isArray(value) || value.length !== type.items.length) {
        throw fault(`${path}: expected a tuple of ${type.items.length}`);
      }
      return type.items.map((t, i) => checkValue(model, t, value[i], `${path}[${i}]`, fault));
    }
    case "result": {
      if (!value || typeof value !== "object" || !("tag" in value)) throw fault(`${path}: expected a result { tag, val }`);
      if (value.tag === "ok") return { tag: "ok", val: type.ok ? checkValue(model, type.ok, value.val, `${path}.val`, fault) : undefined };
      if (value.tag === "err") return { tag: "err", val: type.err ? checkValue(model, type.err, value.val, `${path}.val`, fault) : undefined };
      throw fault(`${path}: result tag must be 'ok' or 'err'`);
    }
    case "named": return checkNamed(model, type, value, path, fault);
    default: throw new Error(`@aircloudhq/testing: unknown WIT type node '${type.kind}'`);
  }
}

function checkPrim(name, value, path, fault) {
  if (name === "bool") {
    if (typeof value !== "boolean") throw fault(`${path}: expected a boolean`);
    return value;
  }
  if (name === "string") {
    if (typeof value !== "string") throw fault(`${path}: expected a string`);
    return value;
  }
  if (name === "char") {
    if (typeof value !== "string" || [...value].length !== 1) throw fault(`${path}: expected a single character`);
    return value;
  }
  if (name === "f32" || name === "f64") {
    if (typeof value !== "number") throw fault(`${path}: expected a number (${name})`);
    return value;
  }
  if (INT_RANGES[name]) {
    const [lo, hi] = INT_RANGES[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < lo || value > hi) {
      throw fault(`${path}: expected an integer in ${name} range`);
    }
    return value;
  }
  if (BIG_RANGES[name]) {
    const [lo, hi] = BIG_RANGES[name];
    if (typeof value !== "bigint" || value < lo || value > hi) {
      throw fault(`${path}: expected a bigint in ${name} range (jco maps 64-bit integers to BigInt)`);
    }
    return value;
  }
  throw new Error(`@aircloudhq/testing: unknown primitive '${name}'`);
}

function checkNamed(model, type, value, path, fault) {
  const def = lookupType(model, type.iface, type.name);
  switch (def.kind) {
    case "alias": return checkValue(model, def.type, value, path, fault);
    case "record": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw fault(`${path}: expected a ${type.name} record object`);
      }
      const out = {};
      for (const f of def.fields) {
        const key = camel(f.name);
        out[key] = checkValue(model, f.type, value[key], `${path}.${key}`, fault);
        if (out[key] === undefined) delete out[key];
      }
      return out;
    }
    case "enum":
      if (typeof value !== "string" || !def.cases.includes(value)) {
        throw fault(`${path}: '${String(value)}' is not one of the cases of ${type.name} (${def.cases.join(", ")})`);
      }
      return value;
    case "variant": {
      if (!value || typeof value !== "object" || typeof value.tag !== "string") {
        throw fault(`${path}: expected a ${type.name} variant { tag, val }`);
      }
      const c = def.cases.find((x) => x.name === value.tag);
      if (!c) throw fault(`${path}: '${value.tag}' is not a case of ${type.name}`);
      if (!c.type) return { tag: c.name };
      return { tag: c.name, val: checkValue(model, c.type, value.val, `${path}.val`, fault) };
    }
    default: throw new Error(`@aircloudhq/testing: unknown declaration kind '${def.kind}'`);
  }
}
