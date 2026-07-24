// Proof-of-Control Evidence appendix (challenge messages + signatures).
// Extracted verbatim from the pre-split builder — zero behavior change.
import { sanitizePdfText } from "@/lib/pdfText";
import { buildChallengeMessage, signatureFormatLabel } from "@/lib/signatureVerify";
import type { PdfLayout, PofPdfData } from "./pof-pdf-context";

export function renderProofOfControlSection(L: PdfLayout, d: PofPdfData) {
  const { doc, margin, contentW } = L;
  const { checkPageBreak } = L;
  const {
    isSample,
    hasVerified,
    effVerifiedRows,
    effName,
    effDate,
    effPurpose,
    effNonce,
  } = d;
  const { verifierReference, freshnessAnchor } = d.params;

  if (!hasVerified) return;

  doc.addPage();
  L.y = 20;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("APPENDIX: PROOF-OF-CONTROL EVIDENCE", margin, L.y);
  L.y += 8;

  doc.setLineWidth(0.5);
  doc.line(margin, L.y, margin + contentW, L.y);
  L.y += 6;

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  const introLines = doc.splitTextToSize(
    sanitizePdfText(
      "The following section contains the challenge message and corresponding wallet signature for each address where cryptographic proof-of-control was provided. " +
      "Legacy addresses use Bitcoin Signed Message signatures; Taproot (bc1p…) addresses use BIP-322 Simple signatures. " +
      "The signature was produced by the declarant using their own wallet or hardware device — no private keys were shared with KYUTXO. " +
      "To independently verify, use a Bitcoin message-verification tool that supports the signature format shown for each address, with the address, message, and signature shown below."
    ),
    contentW
  ) as string[];
  doc.text(introLines, margin, L.y);
  L.y += introLines.length * 8.5 * 0.45 + 6;

  // ── How to independently verify ──────────────────────────────────────
  checkPageBreak(70);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("HOW TO INDEPENDENTLY VERIFY", margin, L.y);
  L.y += 6;

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  const howToIntroLines = doc.splitTextToSize(
    sanitizePdfText(
      "Each address below has a Challenge Message and a Wallet Signature. You can confirm, without KYUTXO and without any network access, that the holder of each address signed that exact message. " +
      "Use any standard Bitcoin signed-message verification tool and supply three inputs: the Address, the Challenge Message (verbatim, including line breaks), and the Wallet Signature (base64)."
    ),
    contentW
  ) as string[];
  doc.text(howToIntroLines, margin, L.y);
  L.y += howToIntroLines.length * 8.5 * 0.45 + 4;

  const verifyMethods = [
    "1. bitcoin-cli (Bitcoin Core): run  bitcoin-cli verifymessage \"<address>\" \"<signature>\" \"<challenge message>\"  — it returns true when the signature is valid for that address and message.",
    "2. Electrum: open Tools > Sign/Verify Message, paste the Address, Challenge Message, and Signature, then click Verify.",
    "3. Any other Bitcoin signed-message verifier (e.g. Sparrow's Verify Message tool, or any offline tool that accepts an address, a message, and a signature) will work the same way.",
  ];
  for (const m of verifyMethods) {
    checkPageBreak(16);
    const mLines = doc.splitTextToSize(sanitizePdfText(m), contentW - 3) as string[];
    doc.setFontSize(8.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0, 0, 0);
    doc.text(mLines, margin + 3, L.y);
    L.y += mLines.length * 8.5 * 0.45 + 2;
  }
  L.y += 3;

  // ── Challenge message & nonce format explanation ─────────────────────
  checkPageBreak(50);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("CHALLENGE MESSAGE FORMAT", margin, L.y);
  L.y += 6;

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0, 0, 0);
  const formatDesc = [
    `The Challenge Message is the human-readable text that was signed for each address. It records the declarant, purpose, date, a unique Declaration Reference (nonce: ${effNonce}), and the address itself.`,
    "The Declaration Reference is a random value generated specifically for this declaration; because it is embedded in every signed message, the signatures cannot be silently reused for a different declaration.",
    "When verifying, the message must be supplied exactly as shown — every character and line break is part of what was signed, so changing even one character will cause verification to fail.",
  ];
  if (!isSample && verifierReference.trim()) {
    formatDesc.push(
      `Verifier Reference: "${verifierReference.trim()}" — a free-text identifier provided by the requesting party and embedded in each signed message, binding the signatures to this specific request.`
    );
  }
  if (!isSample && freshnessAnchor) {
    formatDesc.push(
      `Block Anchor: height ${freshnessAnchor.height}, hash ${freshnessAnchor.hash} (fetched ${freshnessAnchor.fetchedAt}). ` +
      `This anchor proves each signature was created at or after block ${freshnessAnchor.height}. ` +
      "It does not prove an exact timestamp — the verifier can confirm the block on any public explorer."
    );
  }
  const formatLines = doc.splitTextToSize(
    sanitizePdfText(formatDesc.join(" ")),
    contentW
  ) as string[];
  doc.text(formatLines, margin, L.y);
  L.y += formatLines.length * 8.5 * 0.45 + 6;

  for (const row of effVerifiedRows) {
    checkPageBreak(60);

    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    const addrHeadingLines = doc.splitTextToSize(
      sanitizePdfText(`Address: ${row.raw}`),
      contentW
    ) as string[];
    doc.text(addrHeadingLines, margin, L.y);
    L.y += addrHeadingLines.length * 5;

    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    const sigFormatLines = doc.splitTextToSize(
      sanitizePdfText(
        `Signature Format: ${signatureFormatLabel(row.verifiedFormat ?? "legacy")}`
      ),
      contentW
    ) as string[];
    doc.text(sigFormatLines, margin, L.y);
    doc.setTextColor(0, 0, 0);
    L.y += sigFormatLines.length * 5;

    const challengeMsg = buildChallengeMessage({
      address: row.raw,
      declarantName: effName,
      declarationDate: effDate,
      purpose: effPurpose,
      nonce: effNonce,
      verifierReference: isSample ? undefined : (verifierReference || undefined),
      freshnessAnchor: isSample ? undefined : (freshnessAnchor ?? undefined),
    });

    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.text("Challenge Message:", margin, L.y);
    L.y += 4;

    doc.setFont("courier", "normal");
    doc.setFontSize(7.5);
    const msgLines = doc.splitTextToSize(sanitizePdfText(challengeMsg), contentW - 4) as string[];
    doc.setFillColor(245, 245, 245);
    doc.rect(margin, L.y - 1, contentW, msgLines.length * 7.5 * 0.42 + 4, "F");
    doc.text(msgLines, margin + 2, L.y + 1.5);
    L.y += msgLines.length * 7.5 * 0.42 + 6;

    checkPageBreak(20);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(0, 0, 0);
    doc.text(
      row.verifiedFormat === "bip322"
        ? "BIP-322 Witness (base64):"
        : "Wallet Signature (base64):",
      margin,
      L.y
    );
    L.y += 4;

    doc.setFont("courier", "normal");
    doc.setFontSize(7.5);
    const sigLines = doc.splitTextToSize(sanitizePdfText(row.verifiedSig ?? ""), contentW - 4) as string[];
    doc.setFillColor(245, 245, 245);
    doc.rect(margin, L.y - 1, contentW, sigLines.length * 7.5 * 0.42 + 4, "F");
    doc.text(sigLines, margin + 2, L.y + 1.5);
    L.y += sigLines.length * 7.5 * 0.42 + 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(0, 130, 0);
    doc.text(
      sanitizePdfText("Status: Control Verified — signature matches this address."),
      margin,
      L.y
    );
    doc.setTextColor(0, 0, 0);
    L.y += 8;
    doc.setLineWidth(0.2);
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, L.y, margin + contentW, L.y);
    L.y += 5;
  }
}
