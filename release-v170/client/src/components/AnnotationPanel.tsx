import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ACQUISITION_METHOD_OPTIONS, DISPOSITION_TYPE_OPTIONS, FLOW_TYPE_OPTIONS, type BlockchainTransaction, type Record as DbRecord, type TransactionParticipant } from "@/lib/database";
import { deriveAddressAnnotationContext, deriveTransactionAnnotationContext, shouldPersistTransactionRelationships, type AnnotationMetadataValues, type TransactionAnnotationContext } from "@/lib/annotation-context";
import { clearTransactionLegMetadata, ensureRecordEntity, ensureRecordWallet, getAddressOwnership, getAddressOwnershipForRecords, putAddressOwnership, putTransactionLegMetadata, putTransactionMetadata } from "@/lib/data/record-model-crud";
import { bulkGetRecords, createRecord, getRecordsByInputString, updateRecord } from "@/lib/data/record-crud";
import { getTransactionAnnotationRows } from "@/lib/data/transaction-crud";

/** The one deliberately small annotation surface used by record entry points.
 * Full record editing (attachments, evidence and duplicate remediation) remains
 * available from the detail panel; annotation never discards those fields. */
export function AnnotationPanel({ open, onClose, record, transaction, onAdvancedEdit }: {
  open: boolean; onClose: () => void; record?: DbRecord; transaction?: BlockchainTransaction; onAdvancedEdit?: () => void;
}) {
  const [participants, setParticipants] = useState<TransactionParticipant[]>([]);
  const [addresses, setAddresses] = useState<DbRecord[]>([]);
  const [context, setContext] = useState<TransactionAnnotationContext | null>(null);
  const [label, setLabel] = useState(record?.label ?? "");
  const [notes, setNotes] = useState(record?.notes ?? "");
  const [tags, setTags] = useState((record?.tags ?? []).join(", "));
  const [owner, setOwner] = useState(record?.owner ?? "");
  const [wallet, setWallet] = useState(record?.walletName ?? record?.counterpartyName ?? "");
  const [defaults, setDefaults] = useState<AnnotationMetadataValues>({});
  const [overrides, setOverrides] = useState<globalThis.Record<string, AnnotationMetadataValues>>({});
  const [clearedLegs, setClearedLegs] = useState<string[]>([]);
  const [addressOwnership, setAddressOwnership] = useState<Awaited<ReturnType<typeof getAddressOwnership>>>();
  const [ownershipState, setOwnershipState] = useState<"owned" | "external" | "unknown">("owned");
  const [relationshipDirty, setRelationshipDirty] = useState(false);

  useEffect(() => {
    setLabel(record?.label ?? ""); setNotes(record?.notes ?? ""); setTags((record?.tags ?? []).join(", "));
    setOwner(record?.owner ?? ""); setWallet(record?.walletName ?? record?.counterpartyName ?? "");
    setRelationshipDirty(false);
    if (!open || !transaction) {
      setContext(null);
      if (record?.id && record.type === "address") void getAddressOwnership(record.id).then(value => {
        setAddressOwnership(value);
        setOwnershipState(value?.state === "not-ours" ? "external" : value?.state === "undetermined" ? "unknown" : "owned");
      });
      else setAddressOwnership(undefined);
      return;
    }
    void getTransactionAnnotationRows(transaction.txid).then(async ({ participants: parts, metadata, legMetadata: legs }) => {
      const ids = [...new Set(parts.map(p => p.recordId).filter((id): id is number => id != null))];
      const linked = ids.length ? (await bulkGetRecords(ids)).filter((r): r is DbRecord => !!r) : [];
      const ownership = await getAddressOwnershipForRecords(ids);
      const next = deriveTransactionAnnotationContext({ transaction, participants: parts, addressRecords: linked, addressOwnership: ownership, transactionMetadata: metadata, legMetadata: legs });
      setParticipants(parts); setAddresses(linked); setContext(next); setDefaults(next.defaults);
      setOverrides(Object.fromEntries(next.legs.filter(l => l.override).map(l => [l.legKey, l.override!])));
      setClearedLegs([]);
    });
  }, [open, record, transaction]);

  const tagsValue = () => tags.split(",").map(v => v.trim()).filter(Boolean);
  const save = async () => {
    if (transaction) {
      const txid = transaction.txid;
      await putTransactionMetadata({ txid, ...defaults, tags: tagsValue(), notes });
      for (const leg of context?.legs ?? []) {
        const override = overrides[leg.legKey];
        if (override) await putTransactionLegMetadata({ txid, legKey: leg.legKey, direction: leg.direction, ...override });
      }
      for (const legKey of clearedLegs) {
        await clearTransactionLegMetadata(txid, legKey);
      }
      // A transaction-level relationship is a convenient default, but ownership
      // belongs to addresses/legs. Apply it only to legs already derived as ours;
      // external participants remain counterparty evidence rather than becoming
      // accidentally controlled addresses.
      const relationshipContext = shouldPersistTransactionRelationships(context, relationshipDirty) ? context : null;
      if (relationshipContext && relationshipDirty) {
        const ownerName = owner.trim();
        const walletName = wallet.trim();
        const entity = ownerName ? await ensureRecordEntity(ownerName, "self") : undefined;
        const walletRow = walletName ? await ensureRecordWallet({ name: walletName, entityId: entity?.id }) : undefined;
        for (const leg of relationshipContext.legs.filter(candidate => candidate.ownership === "ours")) {
          const participant = participants.find(candidate => `${candidate.role}:${candidate.vout ?? candidate.id ?? candidate.address}` === leg.legKey);
          if (!participant?.recordId) continue;
          const linked = addresses.find(candidate => candidate.id === participant.recordId);
          await putAddressOwnership({ recordId: participant.recordId, state: entity ? "assigned" : "ours-owner-unknown",
            entityId: entity?.id, walletId: walletRow?.id, confidence: linked?.addressImportance });
          if (linked?.id) await updateRecord(linked.id, { owner: ownerName, walletName });
          await putTransactionLegMetadata({ txid, legKey: leg.legKey, direction: leg.direction,
            entityId: entity?.id, walletId: walletRow?.id, ...overrides[leg.legKey] });
        }
        // In a send/receive the same relationship field names the external
        // counterparty. Persist that separately from wallets and never assign
        // it as ownership of an external address.
        if (walletName && (relationshipContext.classification === "send" || relationshipContext.classification === "receive")) {
          const counterparty = await ensureRecordEntity(walletName, "counterparty");
          await putTransactionMetadata({ txid, ...defaults, tags: tagsValue(), notes, counterpartyEntityId: counterparty.id });
          for (const leg of relationshipContext.legs.filter(candidate => candidate.ownership === "external")) {
            const participant = participants.find(candidate => `${candidate.role}:${candidate.vout ?? candidate.id ?? candidate.address}` === leg.legKey);
            if (!participant?.recordId) continue;
            const linked = addresses.find(candidate => candidate.id === participant.recordId);
            await putAddressOwnership({ recordId: participant.recordId, state: "not-ours", counterpartyEntityId: counterparty.id,
              confidence: linked?.addressImportance });
            if (linked?.id) await updateRecord(linked.id, { counterpartyName: walletName });
          }
        }
      }
      const existing = record ?? (await getRecordsByInputString(txid))[0];
      // Keep the legacy record projection in sync as well: existing details,
      // exports and evidence views still consume these durable fields.
      const common = { type: "transaction" as const, inputString: txid, label: label || "Unlabeled", notes,
        tags: tagsValue(), categories: existing?.categories ?? [],
        ...(relationshipDirty ? { owner, walletName: wallet } : {}) };
      if (existing?.id) await updateRecord(existing.id, common); else await createRecord(common);
    } else if (record?.id) {
      const isExternal = ownershipState === "external";
      const controlledBy = owner.trim();
      const relationship = wallet.trim();
      const entity = controlledBy && ownershipState !== "unknown" ? await ensureRecordEntity(controlledBy, isExternal ? "counterparty" : "self") : undefined;
      const walletRow = !isExternal && ownershipState !== "unknown" && relationship
        ? await ensureRecordWallet({ name: relationship, entityId: entity?.id }) : undefined;
      await putAddressOwnership({
        recordId: record.id,
        state: isExternal ? "not-ours" : ownershipState === "unknown" ? "undetermined" : controlledBy ? "assigned" : "ours-owner-unknown",
        entityId: isExternal || ownershipState === "unknown" ? undefined : entity?.id,
        counterpartyEntityId: isExternal ? entity?.id : undefined,
        walletId: isExternal || ownershipState === "unknown" ? undefined : walletRow?.id,
        confidence: record.addressImportance,
      });
      await updateRecord(record.id, {
        label: label || "Unlabeled", notes, tags: tagsValue(),
        owner: isExternal || ownershipState === "unknown" ? "" : owner, walletName: isExternal || ownershipState === "unknown" ? "" : wallet,
        counterpartyName: isExternal ? wallet : "",
      });
    } else if (record) {
      const external = ownershipState === "external";
      const unknown = ownershipState === "unknown";
      const id = await createRecord({ type: "address", inputString: record.inputString, label: label || "Unlabeled", notes, tags: tagsValue(), categories: [],
        owner: external || unknown ? "" : owner, walletName: external || unknown ? "" : wallet, counterpartyName: external ? wallet : "" });
      const entity = owner.trim() && !unknown ? await ensureRecordEntity(owner.trim(), external ? "counterparty" : "self") : undefined;
      const walletRow = wallet.trim() && !external && !unknown ? await ensureRecordWallet({ name: wallet.trim(), entityId: entity?.id }) : undefined;
      await putAddressOwnership({ recordId: id, state: external ? "not-ours" : unknown ? "undetermined" : entity ? "assigned" : "ours-owner-unknown",
        entityId: external || unknown ? undefined : entity?.id, counterpartyEntityId: external ? entity?.id : undefined, walletId: walletRow?.id });
    }
    onClose();
  };
  const question = (name: string) => context?.questions.includes(name as any) ?? false;
  const setDefault = (key: keyof AnnotationMetadataValues, value: string) => setDefaults(v => ({ ...v, [key]: value || undefined }));
  const addressContext = record?.type === "address" ? deriveAddressAnnotationContext(record, addressOwnership) : null;
  return <Dialog open={open} onOpenChange={value => !value && onClose()}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="annotation-panel">
      <DialogHeader><DialogTitle>Annotate {transaction ? "transaction" : "address"}</DialogTitle>
        <DialogDescription>{context?.sentence ?? addressContext?.sentence ?? "Add the facts that describe this record."}</DialogDescription></DialogHeader>
      <div className="space-y-4">
        {addressContext && <Field label="Ownership state"><Select value={ownershipState} onValueChange={value => setOwnershipState(value as typeof ownershipState)}>
          <SelectTrigger data-testid="select-address-ownership-state"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="owned">Owned / controlled by me</SelectItem><SelectItem value="external">External counterparty</SelectItem><SelectItem value="unknown">Unknown</SelectItem></SelectContent>
        </Select></Field>}
        {(question("controlled-by") || !!addressContext) && <Field label="Controlled by"><Input value={owner} onChange={e => { setOwner(e.target.value); setRelationshipDirty(true); }} /></Field>}
        {(question("wallet-or-counterparty") || !!addressContext) && <Field label="Wallet or counterparty"><Input value={wallet} onChange={e => { setWallet(e.target.value); setRelationshipDirty(true); }} /></Field>}
        <Field label="Label"><Input value={label} onChange={e => setLabel(e.target.value)} /></Field>
        <Field label="Notes"><Textarea value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        <Field label="Tags (comma separated)"><Input value={tags} onChange={e => setTags(e.target.value)} /></Field>
        {transaction && <Choice label="Flow" value={defaults.flowType} options={FLOW_TYPE_OPTIONS} onChange={v => setDefault("flowType", v)} />}
        {transaction && question("acquisition-method") && <Choice label="Acquisition method" value={defaults.acquisitionMethod} options={ACQUISITION_METHOD_OPTIONS} onChange={v => setDefault("acquisitionMethod", v)} />}
        {transaction && question("disposition-type") && <Choice label="Disposition type" value={defaults.dispositionType} options={DISPOSITION_TYPE_OPTIONS} onChange={v => setDefault("dispositionType", v)} />}
        {transaction && context?.legs.map(leg => <div key={leg.legKey} className="rounded border p-3 space-y-2"><p className="text-sm font-medium">{leg.role} · {leg.address || "Unknown address"}</p>
          <Choice label="Per-leg flow override" value={overrides[leg.legKey]?.flowType} options={FLOW_TYPE_OPTIONS} onChange={v => setOverrides(all => ({ ...all, [leg.legKey]: { ...all[leg.legKey], flowType: v as any } }))} />
          {question("acquisition-method") && <Choice label="Per-leg acquisition override" value={overrides[leg.legKey]?.acquisitionMethod} options={ACQUISITION_METHOD_OPTIONS} onChange={v => setOverrides(all => ({ ...all, [leg.legKey]: { ...all[leg.legKey], acquisitionMethod: v as any } }))} />}
          {question("disposition-type") && <Choice label="Per-leg disposition override" value={overrides[leg.legKey]?.dispositionType} options={DISPOSITION_TYPE_OPTIONS} onChange={v => setOverrides(all => ({ ...all, [leg.legKey]: { ...all[leg.legKey], dispositionType: v as any } }))} />}
          {overrides[leg.legKey] && <Button type="button" size="sm" variant="ghost" onClick={() => {
            setOverrides(all => { const next = { ...all }; delete next[leg.legKey]; return next; });
            setClearedLegs(keys => [...new Set([...keys, leg.legKey])]);
          }}>Use transaction defaults</Button>}
        </div>)}
      </div>
      <DialogFooter>{onAdvancedEdit && <Button variant="outline" onClick={onAdvancedEdit} data-testid="button-annotation-advanced-edit">Attachments, evidence & more</Button>}<Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => void save()}>Save annotation</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }
function Choice({ label, value, options, onChange }: { label: string; value?: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void }) {
  return <Field label={label}><Select value={value ?? ""} onValueChange={onChange}><SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>;
}