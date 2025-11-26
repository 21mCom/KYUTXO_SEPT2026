import { BitcoinAddressDisplay } from "../BitcoinAddressDisplay";

export default function BitcoinAddressDisplayExample() {
  return (
    <div className="p-4 space-y-4">
      <BitcoinAddressDisplay address="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" />
      <BitcoinAddressDisplay 
        address="1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" 
        truncate={false}
      />
    </div>
  );
}
