import { useState } from "react";
import { Plus, Grid3x3, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchBar } from "@/components/SearchBar";
import { FilterBar } from "@/components/FilterBar";
import { RecordCard } from "@/components/RecordCard";
import { RecordTable } from "@/components/RecordTable";
import { RecordDetailPanel } from "@/components/RecordDetailPanel";
import { RecordFormDialog } from "@/components/RecordFormDialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const mockRecords = [
  {
    id: "1",
    type: "address" as const,
    inputString: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    label: "Cold Storage Wallet",
    notes: "Main cold storage wallet for long-term holdings.",
    amount: 2.5,
    date: "2024-01-15",
    tags: ["cold-storage", "savings"],
    categories: ["Personal"],
    seedName: "Seed #1",
    walletSoftware: "Electrum 4.5.2",
    attachments: [
      { id: "1", filename: "receipt.pdf", size: 245600 },
    ],
  },
  {
    id: "2",
    type: "transaction" as const,
    inputString: "3e3dbe6d0f0a3b9f8e7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5",
    label: "Exchange Deposit",
    amount: 0.15,
    date: "2024-02-20",
    tags: ["exchange"],
    categories: ["Trading"],
    counterparty: "Coinbase",
    notes: "Deposit to exchange for trading",
  },
  {
    id: "3",
    type: "address" as const,
    inputString: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    label: "Genesis Address",
    amount: 50,
    date: "2009-01-03",
    tags: ["historic", "genesis"],
    categories: ["Reference"],
  },
];

export default function Dashboard() {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "table">("table");
  const [filter, setFilter] = useState<{
    type?: "address" | "transaction" | "all";
    tags: string[];
    categories: string[];
  }>({
    type: "all",
    tags: [],
    categories: [],
  });
  const [selectedRecord, setSelectedRecord] = useState<typeof mockRecords[0] | undefined>();
  const [showDetail, setShowDetail] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const handleRecordClick = (id: string) => {
    const record = mockRecords.find(r => r.id === id);
    setSelectedRecord(record);
    setShowDetail(true);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search records..."
            className="max-w-md"
          />
          <div className="flex items-center gap-2">
            <Tabs value={view} onValueChange={(v) => setView(v as "grid" | "table")}>
              <TabsList>
                <TabsTrigger value="table" data-testid="button-view-table">
                  <List className="h-4 w-4" />
                </TabsTrigger>
                <TabsTrigger value="grid" data-testid="button-view-grid">
                  <Grid3x3 className="h-4 w-4" />
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button onClick={() => setShowForm(true)} data-testid="button-create-record">
              <Plus className="h-4 w-4 mr-2" />
              New Record
            </Button>
          </div>
        </div>

        <FilterBar
          filter={filter}
          onChange={setFilter}
          availableTags={["cold-storage", "hot-wallet", "exchange", "savings", "historic", "genesis"]}
          availableCategories={["Personal", "Business", "Trading", "Reference"]}
        />
      </div>

      <div className="flex-1 overflow-auto p-4">
        {view === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {mockRecords.map((record) => (
              <RecordCard
                key={record.id}
                {...record}
                attachmentCount={record.attachments?.length || 0}
                onClick={() => handleRecordClick(record.id)}
                onEdit={() => console.log("Edit", record.id)}
                onDelete={() => console.log("Delete", record.id)}
              />
            ))}
          </div>
        ) : (
          <RecordTable
            records={mockRecords}
            onRowClick={handleRecordClick}
            onEdit={(id) => console.log("Edit", id)}
            onDelete={(id) => console.log("Delete", id)}
          />
        )}
      </div>

      <RecordDetailPanel
        open={showDetail}
        onClose={() => setShowDetail(false)}
        onEdit={() => {
          setShowDetail(false);
          setShowForm(true);
        }}
        record={selectedRecord}
      />

      <RecordFormDialog
        open={showForm}
        onClose={() => setShowForm(false)}
        onSave={(data) => {
          console.log("Saved:", data);
        }}
      />
    </div>
  );
}
