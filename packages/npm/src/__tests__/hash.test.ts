import { describe, it, expect } from "vitest";
import { fnv1a, hashParams } from "../hash.js";

describe("fnv1a", () => {
  it("returns consistent hashes", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
  });

  it("returns different hashes for different inputs", () => {
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });

  it("returns unsigned 32-bit integers", () => {
    const h = fnv1a("test");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("hashParams", () => {
  it("produces same hash for same params", () => {
    const a = hashParams({ query: "weather", location: "paris" });
    const b = hashParams({ query: "weather", location: "paris" });
    expect(a).toBe(b);
  });

  it("is key-order independent", () => {
    const a = hashParams({ query: "weather", location: "paris" });
    const b = hashParams({ location: "paris", query: "weather" });
    expect(a).toBe(b);
  });

  it("different params produce different hashes", () => {
    const a = hashParams({ query: "weather" });
    const b = hashParams({ query: "news" });
    expect(a).not.toBe(b);
  });
});
