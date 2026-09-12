---
name: Hop/tx classification needs full participant sets
description: Classifying a transaction (partial spend vs reorg vs origin) from address-keyed or owned-only participant loads silently misclassifies; blank Electrum inputs need prevout ownership.
---

Any logic that classifies a transaction by participant ownership (partial
spend vs wallet reorg vs external origin, owned in/out counts, "who did this
tx pay") must run on the COMPLETE participant set for that tx.

**Why:** Address-keyed loads (`getParticipantsByAddresses(owned)`) return only
rows whose address is owned. Counterparty rows vanish, so a partial spend
looks like a wallet reorg (all visible outputs owned) and a normal tx with an
unloaded input looks like a coinbase (no visible inputs). This produced
confidently-wrong UI in the UTXO Provenance page and only a real-browser
check caught it.

Separately, Electrum-synced inputs carry a blank address; ownership must be
derived from the input's prevTxid:prevVout output, else every Electrum spend
classifies as an external origin.

**How to apply:** When loading txs for classification/display, re-fetch full
participants per txid (chunked `getParticipantsByTxids`) instead of reusing
owned-side query results; resolve blank-input ownership through the prevout
lookup. Keep unspent-set detection on the owned+spend-input load (parity with
the UTXOs page) — only classification/dialog display needs the full set.
