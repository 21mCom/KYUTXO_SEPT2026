// Glossary of Terms appendix. Extracted verbatim from the pre-split
// builder — zero behavior change.
import { sanitizePdfText } from "@/lib/pdfText";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";
import { GLOSSARY_APPENDIX_HEADING } from "./pof-pdf-strings";

export function renderGlossarySection(L: PdfLayout, d: PofPdfData) {
  const { doc, margin, contentW } = L;
  const { checkPageBreak } = L;
  const { includeGlossary } = d.params;

  if (!includeGlossary) return;

  doc.addPage();
  L.y = 20;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(GLOSSARY_APPENDIX_HEADING, margin, L.y);
  L.y += 8;
  doc.setLineWidth(0.5);
  doc.line(margin, L.y, margin + contentW, L.y);
  L.y += 5;

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);
  const glossaryIntroLines = doc.splitTextToSize(
    sanitizePdfText(
      "This glossary provides plain-language explanations of technical terms used in this declaration, " +
      "for the benefit of non-technical reviewers."
    ),
    contentW
  ) as string[];
  doc.text(glossaryIntroLines, margin, L.y);
  L.y += glossaryIntroLines.length * 8.5 * 0.45 + 5;
  doc.setTextColor(0, 0, 0);

  const glossaryTerms: [string, string][] = [
    [
      "Bitcoin",
      "A decentralized digital currency that operates on a peer-to-peer network without a central authority. Transactions are recorded on a public ledger called the blockchain.",
    ],
    [
      "Bitcoin Address",
      "A unique identifier — similar to a bank account number — used to receive Bitcoin. An address is derived from a cryptographic key pair. Common formats begin with '1', '3', or 'bc1'.",
    ],
    [
      "Balance",
      "The total amount of Bitcoin currently held at an address, measured in BTC or satoshis, as reported by the blockchain at the time of declaration.",
    ],
    [
      "BTC",
      "The symbol for Bitcoin. One BTC equals 100,000,000 satoshis (sat). Balances in this document are expressed in BTC unless otherwise noted.",
    ],
    [
      "Satoshi (sat)",
      "The smallest unit of Bitcoin. 1 BTC = 100,000,000 satoshis. Named after Bitcoin's pseudonymous creator, Satoshi Nakamoto.",
    ],
    [
      "Blockchain",
      "A public, append-only ledger that permanently records all Bitcoin transactions. Each block of transactions is cryptographically linked to the previous one, making the history tamper-evident.",
    ],
    [
      "Block",
      "A batch of confirmed Bitcoin transactions added to the blockchain. Each block is identified by its height (position in the chain). Block height is used in this document as a time-anchor for reported balances.",
    ],
    [
      "Confirmation",
      "A transaction is 'confirmed' once it has been included in a block and broadcast across the network. Each subsequent block mined on top adds another confirmation, increasing finality.",
    ],
    [
      "UTXO (Unspent Transaction Output)",
      "The fundamental accounting unit of Bitcoin. Each received Bitcoin amount creates a UTXO; spending Bitcoin consumes one or more UTXOs as inputs and creates new UTXOs as outputs. An address's balance is the sum of its UTXOs.",
    ],
    [
      "xpub (Extended Public Key)",
      "A public key from which an entire sequence of Bitcoin addresses can be derived without exposing private keys. Sharing an xpub allows read-only balance monitoring across all derived addresses.",
    ],
    [
      "Proof of Control",
      "Cryptographic evidence that the declarant holds the private key corresponding to a Bitcoin address, demonstrated by signing a unique challenge message with that key using their wallet.",
    ],
    [
      "Bitcoin Signed Message",
      "A standard format for signing a text message with a Bitcoin private key, producing a base64-encoded signature that can be independently verified against the address. Supported by most Bitcoin wallets.",
    ],
    [
      "BIP-322",
      "Bitcoin Improvement Proposal 322 — a newer signing standard that supports modern address types including Taproot (bc1p…) addresses, using Schnorr signatures.",
    ],
    [
      "Hop",
      "A single transaction step between two Bitcoin addresses in the transaction graph. A '2-hop' connection means there are two intermediate transactions between the declared address and a named counterparty.",
    ],
    [
      "SHA-256",
      "A cryptographic hash function that produces a fixed-length (256-bit / 64-character hex) fingerprint from any input. Even a single character change in the input produces a completely different hash, making it useful for detecting document alterations.",
    ],
    [
      "Declaration Reference (Nonce)",
      "A randomly generated, unique identifier assigned to this declaration at the time of generation. It is embedded in every signed challenge message to prevent signatures from being reused across different declarations.",
    ],
    [
      "PEP (Politically Exposed Person)",
      "An individual who holds or has held a prominent public function (e.g. head of state, senior government official, senior judicial or military official). Financial institutions apply enhanced due diligence to PEPs.",
    ],
    [
      "AML (Anti-Money Laundering)",
      "Laws, regulations, and procedures designed to prevent criminals from disguising illegally obtained funds as legitimate income. AML compliance requires financial institutions to screen customers and their transaction histories.",
    ],
    [
      "KYC (Know Your Customer)",
      "A set of identity verification procedures financial institutions use to confirm the identity of their clients and assess the risk of illegal activity such as money laundering or fraud.",
    ],
  ];

  for (const [term, definition] of glossaryTerms) {
    const defLines = doc.splitTextToSize(sanitizePdfText(definition), contentW - 4) as string[];
    const neededHeight = 5 + defLines.length * 8.5 * 0.45 + 4;
    checkPageBreak(neededHeight + 2);

    doc.setFontSize(8.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text(sanitizePdfText(term), margin, L.y);
    L.y += 4.5;

    doc.setFont("helvetica", "normal");
    doc.setTextColor(50, 50, 50);
    doc.text(defLines, margin + 4, L.y);
    doc.setTextColor(0, 0, 0);
    L.y += defLines.length * 8.5 * 0.45 + 3;
  }
}
