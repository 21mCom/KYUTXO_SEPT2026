import { useState } from "react";
import { FilterBar } from "../FilterBar";

export default function FilterBarExample() {
  const [filter, setFilter] = useState<{
    type?: "address" | "transaction" | "all";
    tags: string[];
    categories: string[];
  }>({
    type: "all",
    tags: [],
    categories: [],
  });

  return (
    <div className="p-4">
      <FilterBar
        filter={filter}
        onChange={setFilter}
        availableTags={["cold-storage", "hot-wallet", "exchange", "savings"]}
        availableCategories={["Personal", "Business", "Trading"]}
      />
      <pre className="mt-4 p-2 bg-muted rounded text-xs">
        {JSON.stringify(filter, null, 2)}
      </pre>
    </div>
  );
}
