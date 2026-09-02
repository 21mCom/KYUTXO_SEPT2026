// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

import * as mod from "./use-encrypted-records";

describe("use-encrypted-records", () => {
  it("exports an empty module", () => {
    expect(Object.keys(mod)).toHaveLength(0);
  });
});
