import { describe, expect, it } from "vitest";

import { modelAccount } from "./modelAccount";

describe("modelAccount", () => {
  it("uses this project's own key when nothing else is set", () => {
    expect(modelAccount({ EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "own" })).toEqual({ secret: "own", source: "project" });
  });

  it("uses the other account's key when one is set", () => {
    expect(modelAccount({ EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "own", MODEL_ACCOUNT_KEY: " other \n" })).toEqual({ secret: "other", source: "other" });
  });

  it("treats a blank override as not set", () => {
    expect(modelAccount({ EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: "own", MODEL_ACCOUNT_KEY: "   " })).toEqual({ secret: "own", source: "project" });
  });

  it("returns an empty key rather than inventing one", () => {
    expect(modelAccount({})).toEqual({ secret: "", source: "project" });
  });
});
