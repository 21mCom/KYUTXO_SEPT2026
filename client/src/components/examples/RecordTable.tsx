import { RecordTable } from "../RecordTable";

const mockRecords = [
  {
    id: "1",
    type: "address" as const,
    inputString: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    label: "Cold Storage Wallet",
    amount: 2.5,
    date: "2024-01-15",
    tags: ["cold-storage", "savings", "hardware-wallet"],
  },
  {
    id: "2",
    type: "transaction" as const,
    inputString: "3e3dbe6d0f0a3b9f8e7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5",
    label: "Exchange Deposit",
    amount: 0.15,
    date: "2024-02-20",
    tags: ["exchange", "coinbase"],
  },
];

export default function RecordTableExample() {
  return (
    <div className="p-4">
      <RecordTable
        records={mockRecords}
        onEdit={(id) => console.log("Edit", id)}
        onDelete={(id) => console.log("Delete", id)}
        onRowClick={(id) => console.log("Row clicked", id)}
      />
    </div>
  );
}
