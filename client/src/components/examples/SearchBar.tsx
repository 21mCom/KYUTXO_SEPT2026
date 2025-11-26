import { useState } from "react";
import { SearchBar } from "../SearchBar";

export default function SearchBarExample() {
  const [search, setSearch] = useState("");

  return (
    <div className="p-4 max-w-md">
      <SearchBar value={search} onChange={setSearch} />
      {search && (
        <p className="mt-2 text-sm text-muted-foreground">
          Searching for: {search}
        </p>
      )}
    </div>
  );
}
