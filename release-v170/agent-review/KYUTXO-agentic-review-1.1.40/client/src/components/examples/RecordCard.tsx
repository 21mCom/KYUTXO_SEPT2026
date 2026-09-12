import { RecordCard } from "../RecordCard";

export default function RecordCardExample() {
  return (
    <div className="p-4 space-y-4 max-w-md">
      <RecordCard
        id="1"
        type="address"
        inputString="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
        label="Cold Storage Wallet"
        amount={2.5}
        date="2024-01-15"
        tags={["cold-storage", "savings"]}
        attachmentCount={3}
        onEdit={() => console.log("Edit clicked")}
        onDelete={() => console.log("Delete clicked")}
        onClick={() => console.log("Card clicked")}
      />
      <RecordCard
        id="2"
        type="transaction"
        inputString="3e3dbe6d0f0a3b9f8e7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5"
        label="Exchange Deposit"
        amount={0.15}
        date="2024-02-20"
        tags={["exchange", "coinbase"]}
        onClick={() => console.log("Card clicked")}
      />
    </div>
  );
}
