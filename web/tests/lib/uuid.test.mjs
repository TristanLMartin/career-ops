import test from "node:test";
import assert from "node:assert/strict";
import { uuid } from "../../src/lib/uuid.mjs";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withCrypto(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
  try { fn(); } finally { Object.defineProperty(globalThis, "crypto", desc); }
}

test("uses crypto.randomUUID when present", () => {
  assert.match(uuid(), V4);
});

test("falls back to getRandomValues when randomUUID is missing (non-secure context)", () => {
  const real = globalThis.crypto;
  withCrypto({ getRandomValues: (a) => real.getRandomValues(a) }, () => {
    const ids = new Set(Array.from({ length: 200 }, uuid));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, V4);
  });
});

test("falls back to Math.random when crypto is absent", () => {
  withCrypto(undefined, () => {
    assert.match(uuid(), V4);
    assert.notEqual(uuid(), uuid());
  });
});
