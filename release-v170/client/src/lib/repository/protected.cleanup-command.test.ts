import { describe, expect, it, vi } from "vitest";
import { ProtectedVaultRepository } from "./protected";

describe("ProtectedVaultRepository cleanup command", () => {
  it("uses the fixed native command rather than a renderer transaction", async () => {
    const command = vi.fn().mockResolvedValue({ ok: true, result: { deleted: true } });
    const repository = new ProtectedVaultRepository({
      repository: { command },
    } as any);

    await expect(
      repository.command("cleanup.deleteRecordWithOrigins", { recordId: 42 }),
    ).resolves.toEqual({ deleted: true });
    expect(command).toHaveBeenCalledWith("cleanup.deleteRecordWithOrigins", { recordId: 42 });
  });
});