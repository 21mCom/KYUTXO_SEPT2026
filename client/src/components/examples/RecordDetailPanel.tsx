import { useState } from "react";
import { RecordDetailPanel } from "../RecordDetailPanel";
import { Button } from "@/components/ui/button";

const mockRecord = {
  id: "1",
  type: "address" as const,
  inputString: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  label: "Cold Storage Wallet",
  notes: "Main cold storage wallet for long-term holdings. Hardware wallet secured in safe deposit box.",
  amount: 2.5,
  date: "2024-01-15",
  tags: ["cold-storage", "savings", "hardware-wallet"],
  categories: ["Personal", "Long-term"],
  seedName: "Seed #1",
  walletSoftware: "Electrum 4.5.2",
  attachments: [
    { id: "1", filename: "receipt.pdf", size: 245600 },
    { id: "2", filename: "wallet_photo.jpg", size: 1024000 },
  ],
};

export default function RecordDetailPanelExample() {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-4">
      <Button onClick={() => setOpen(true)} data-testid="button-open-panel">
        Open Detail Panel
      </Button>
      <RecordDetailPanel
        open={open}
        onClose={() => setOpen(false)}
        onEdit={() => console.log("Edit clicked")}
        record={mockRecord}
      />
    </div>
  );
}
