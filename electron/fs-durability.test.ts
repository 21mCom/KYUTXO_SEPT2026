import { describe, expect, it, vi } from "vitest";

const { syncDirectory } = require("./fs-durability.cjs") as {
  syncDirectory: (
    directory: string,
    options?: { open?: (directory: string, mode: string) => Promise<{
      sync: () => Promise<void>;
      close: () => Promise<void>;
    }> },
  ) => Promise<boolean>;
};

describe("directory durability", () => {
  it.each(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"])(
    "tolerates unsupported directory sync code %s",
    async (code) => {
      const open = vi.fn(async () => {
        throw Object.assign(new Error("unsupported directory sync"), { code });
      });
      await expect(syncDirectory("unused", { open })).resolves.toBe(false);
      expect(open).toHaveBeenCalledWith("unused", "r");
    },
  );

  it("closes the directory handle when its sync is unsupported", async () => {
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({
      sync: async () => {
        throw Object.assign(new Error("unsupported directory sync"), { code: "EPERM" });
      },
      close,
    }));
    await expect(syncDirectory("unused", { open })).resolves.toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed on real directory I/O errors", async () => {
    const open = vi.fn(async () => {
      throw Object.assign(new Error("disk failure"), { code: "EIO" });
    });
    await expect(syncDirectory("unused", { open })).rejects.toThrow("disk failure");
  });
});