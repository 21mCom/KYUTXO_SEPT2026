// Public block-explorer services a recipient can use to independently look up an
// address's balance. The QR code simply ENCODES the explorer URL as text — it is
// generated entirely offline (no network call, no remote QR image service). The
// recipient chooses whether to scan it and contact the third-party explorer.
export type ExplorerId = "mempool" | "blockstream" | "blockchain" | "blockchair";

export interface ExplorerDef {
  id: ExplorerId;
  label: string;
  // Human-readable host shown under each QR code in the UI and PDF.
  host: string;
  // Builds the public address page URL that the QR code encodes.
  addressUrl: (address: string) => string;
}

export const QR_EXPLORERS: ExplorerDef[] = [
  {
    id: "mempool",
    label: "mempool.space",
    host: "mempool.space",
    addressUrl: (a) => `https://mempool.space/address/${a}`,
  },
  {
    id: "blockstream",
    label: "Blockstream.info",
    host: "blockstream.info",
    addressUrl: (a) => `https://blockstream.info/address/${a}`,
  },
  {
    id: "blockchain",
    label: "Blockchain.com",
    host: "blockchain.com",
    addressUrl: (a) => `https://www.blockchain.com/explorer/addresses/btc/${a}`,
  },
  {
    id: "blockchair",
    label: "Blockchair",
    host: "blockchair.com",
    addressUrl: (a) => `https://blockchair.com/bitcoin/address/${a}`,
  },
];

export function getExplorer(id: ExplorerId): ExplorerDef {
  return QR_EXPLORERS.find((e) => e.id === id) ?? QR_EXPLORERS[0];
}
