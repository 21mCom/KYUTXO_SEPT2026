import { useEffect, useState } from "react";
import { Building2, Loader2, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import * as ownerPolicyCrud from "@/lib/data/owner-policy-crud";

/**
 * The owner-policy service is deliberately the source of truth for this screen.
 * Expected service signatures:
 * listOwnerPolicies(), ensureDefaultOwner(), createOwnerPolicy(input),
 * updateOwnerPolicy(id, input), archiveOwnerPolicy(id), listResidencies(ownerId),
 * createResidency(input), updateResidency(id, input), deleteResidency(id), and
 * getOwnerPolicySummaries(). The service validates ranges and archive safety.
 */
type OwnerKind = "person" | "company";
type MatchingMethod = "fifo" | "lifo" | "hifo" | "specific-identification" | "proportional";
interface Owner { id: number; name: string; kind: OwnerKind; archivedAt?: string | null; isDefault?: boolean }
interface Residency { id: number; ownerId: number; jurisdiction: string; region?: string | null; notes?: string | null; startsOn: string; endsOn?: string | null; matchingMethod: MatchingMethod }
interface OwnerSummary { ownerId: number; currentHoldings?: number; unassignedBatches?: number; disposalsOutsideResidency?: number }
type OwnerApi = {
  listOwnerPolicies: () => Promise<Owner[]>;
  ensureDefaultOwner: () => Promise<unknown>;
  createOwnerPolicy: (input: Pick<Owner, "name" | "kind">) => Promise<unknown>;
  updateOwnerPolicy: (id: number, input: Pick<Owner, "name" | "kind">) => Promise<unknown>;
  archiveOwnerPolicy: (id: number) => Promise<unknown>;
  listResidencies: (ownerId: number) => Promise<Residency[]>;
  createResidency: (input: Omit<Residency, "id">) => Promise<unknown>;
  updateResidency: (id: number, input: Omit<Residency, "id" | "ownerId">) => Promise<unknown>;
  deleteResidency: (id: number) => Promise<unknown>;
  getOwnerPolicySummaries: () => Promise<OwnerSummary[]>;
};
const api = ownerPolicyCrud as unknown as OwnerApi;

const methods: { value: MatchingMethod; label: string }[] = [
  { value: "fifo", label: "FIFO (first in, first out)" },
  { value: "lifo", label: "LIFO (last in, first out)" },
  { value: "hifo", label: "HIFO (highest in, first out)" },
  { value: "specific-identification", label: "Specific identification" },
  { value: "proportional", label: "Proportional" },
];
const emptyOwner = { name: "", kind: "person" as OwnerKind };
const emptyResidency = { jurisdiction: "", region: "", notes: "", startsOn: "", endsOn: "", matchingMethod: "fifo" as MatchingMethod };

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not save this change.";
}

export function OwnersSection() {
  const { toast } = useToast();
  const [owners, setOwners] = useState<Owner[]>([]);
  const [summaries, setSummaries] = useState<OwnerSummary[]>([]);
  const [residencies, setResidencies] = useState<Record<number, Residency[]>>({});
  const [loading, setLoading] = useState(true);
  const [ownerDialog, setOwnerDialog] = useState<Owner | "new" | null>(null);
  const [ownerForm, setOwnerForm] = useState(emptyOwner);
  const [residencyDialog, setResidencyDialog] = useState<{ ownerId: number; residency?: Residency } | null>(null);
  const [residencyForm, setResidencyForm] = useState(emptyResidency);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      await api.ensureDefaultOwner();
      const loadedOwners = await api.listOwnerPolicies();
      const active = loadedOwners.filter(owner => !owner.archivedAt);
      const [loadedSummaries, residencyLists] = await Promise.all([
        api.getOwnerPolicySummaries(),
        Promise.all(active.map(async owner => [owner.id, await api.listResidencies(owner.id)] as const)),
      ]);
      setOwners(active);
      setSummaries(loadedSummaries);
      setResidencies(Object.fromEntries(residencyLists));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const saveOwner = async () => {
    const name = ownerForm.name.trim();
    if (!name) return;
    setSaving(true); setError("");
    try {
      if (ownerDialog === "new") await api.createOwnerPolicy({ name, kind: ownerForm.kind });
      else if (ownerDialog) await api.updateOwnerPolicy(ownerDialog.id, { name, kind: ownerForm.kind });
      setOwnerDialog(null); await load();
      toast({ title: ownerDialog === "new" ? "Owner added" : "Owner updated" });
    } catch (cause) { setError(message(cause)); } finally { setSaving(false); }
  };
  const archive = async (owner: Owner) => {
    setSaving(true); setError("");
    try {
      await api.archiveOwnerPolicy(owner.id);
      await load();
      toast({ title: "Owner archived", description: `${owner.name} is no longer available for new assignments.` });
    } catch (cause) { setError(message(cause)); } finally { setSaving(false); }
  };
  const saveResidency = async () => {
    if (!residencyDialog || !residencyForm.jurisdiction.trim() || !residencyForm.startsOn) return;
    setSaving(true); setError("");
    const input = { ...residencyForm, jurisdiction: residencyForm.jurisdiction.trim(), region: residencyForm.region.trim() || null, notes: residencyForm.notes.trim() || null, endsOn: residencyForm.endsOn || null };
    try {
      if (residencyDialog.residency) await api.updateResidency(residencyDialog.residency.id, input);
      else await api.createResidency({ ...input, ownerId: residencyDialog.ownerId });
      setResidencyDialog(null); await load();
      toast({ title: "Residency saved" });
    } catch (cause) { setError(message(cause)); } finally { setSaving(false); }
  };
  const removeResidency = async (residency: Residency) => {
    setSaving(true); setError("");
    try { await api.deleteResidency(residency.id); await load(); toast({ title: "Residency removed" }); }
    catch (cause) { setError(message(cause)); } finally { setSaving(false); }
  };
  const openOwner = (owner: Owner | "new") => {
    setError(""); setOwnerDialog(owner);
    setOwnerForm(owner === "new" ? emptyOwner : { name: owner.name, kind: owner.kind });
  };
  const openResidency = (ownerId: number, residency?: Residency) => {
    setError(""); setResidencyDialog({ ownerId, residency });
    setResidencyForm(residency ? { jurisdiction: residency.jurisdiction, region: residency.region ?? "", notes: residency.notes ?? "", startsOn: residency.startsOn, endsOn: residency.endsOn ?? "", matchingMethod: residency.matchingMethod } : emptyResidency);
  };
  const total = (key: Exclude<keyof OwnerSummary, "unassignedBatches">) => summaries.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
  // Unassigned batches describe the vault, rather than an individual owner's
  // holdings. Current service summaries repeat that vault-wide value per owner.
  const defaultOwnerId = owners.find(owner => owner.isDefault)?.id;
  const unassignedBatches = Number(
    defaultOwnerId === undefined
      ? 0
      : summaries.find(summary => summary.ownerId === defaultOwnerId)?.unassignedBatches,
  ) || 0;
  const hasResidencyGap = (blocks: Residency[]) => {
    const ordered = [...blocks].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
    return ordered.some((block, index) => {
      if (!index) return false;
      const previousEnd = ordered[index - 1].endsOn;
      if (!previousEnd) return false;
      const dayAfterPreviousEnd = new Date(`${previousEnd}T00:00:00Z`);
      dayAfterPreviousEnd.setUTCDate(dayAfterPreviousEnd.getUTCDate() + 1);
      return dayAfterPreviousEnd.toISOString().slice(0, 10) < block.startsOn;
    });
  };

  return <Card data-testid="owners-settings">
    <CardHeader>
      <div className="flex items-start justify-between gap-3">
        <div><CardTitle className="flex items-center gap-2"><UserRound className="h-5 w-5" />Owners</CardTitle>
          <CardDescription>Set who owns the books and the residency policy used for each disposal date.</CardDescription></div>
        <Button size="sm" onClick={() => openOwner("new")} data-testid="button-add-owner"><Plus className="mr-1 h-4 w-4" />Add owner</Button>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive" data-testid="owners-error">{error}</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-md bg-muted p-3" data-testid="owner-summary-holdings"><p className="text-xs text-muted-foreground">Current holdings</p><p className="text-xl font-semibold">{total("currentHoldings")}</p></div>
        <div className="rounded-md bg-muted p-3" data-testid="owner-summary-unassigned"><p className="text-xs text-muted-foreground">Unassigned batches</p><p className="text-xl font-semibold">{unassignedBatches}</p></div>
        <div className="rounded-md bg-muted p-3" data-testid="owner-summary-outside-residency"><p className="text-xs text-muted-foreground">Disposals outside residency</p><p className="text-xl font-semibold">{total("disposalsOutsideResidency")}</p></div>
      </div>
      {loading ? <div className="flex gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading owners…</div> :
        owners.map(owner => <section key={owner.id} className="rounded-md border p-4" data-testid={`owner-card-${owner.id}`}>
          <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-2"><>{owner.kind === "company" ? <Building2 className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}</><span className="font-medium">{owner.name}</span>{owner.isDefault && <Badge variant="secondary">Default</Badge>}</div>
            <div className="flex gap-1"><Button variant="ghost" size="icon" aria-label={`Edit ${owner.name}`} onClick={() => openOwner(owner)} data-testid={`button-edit-owner-${owner.id}`}><Pencil className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label={`Archive ${owner.name}`} disabled={saving} onClick={() => void archive(owner)} data-testid={`button-archive-owner-${owner.id}`}><Trash2 className="h-4 w-4" /></Button></div></div>
          <div className="mt-4 space-y-2"><div className="flex items-center justify-between"><p className="text-sm font-medium">Residency history</p><Button size="sm" variant="outline" onClick={() => openResidency(owner.id)} data-testid={`button-add-residency-${owner.id}`}><Plus className="mr-1 h-3.5 w-3.5" />Add residency</Button></div>
            {(residencies[owner.id] ?? []).length === 0 ? <p className="text-sm text-amber-700 dark:text-amber-400" data-testid={`residency-gap-warning-${owner.id}`}>No residency is set. Disposals for this owner will need review.</p> :
              <>{hasResidencyGap(residencies[owner.id] ?? []) && <p className="text-sm text-amber-700 dark:text-amber-400" data-testid={`residency-gap-warning-${owner.id}`}>There is a gap between residency blocks. Disposals in that period will need review.</p>}
              {(residencies[owner.id] ?? []).map(block => <div key={block.id} className="flex items-center justify-between rounded bg-muted/50 px-3 py-2 text-sm" data-testid={`residency-block-${block.id}`}><div><span className="font-medium">{block.jurisdiction}{block.region ? ` · ${block.region}` : ""}</span><span className="ml-2 text-muted-foreground">{block.startsOn} – {block.endsOn || "ongoing"} · {methods.find(method => method.value === block.matchingMethod)?.label}</span>{block.notes && <p className="text-xs text-muted-foreground">{block.notes}</p>}</div><div className="flex"><Button size="icon" variant="ghost" aria-label="Edit residency" onClick={() => openResidency(owner.id, block)} data-testid={`button-edit-residency-${block.id}`}><Pencil className="h-3.5 w-3.5" /></Button><Button size="icon" variant="ghost" aria-label="Delete residency" disabled={saving} onClick={() => void removeResidency(block)} data-testid={`button-delete-residency-${block.id}`}><Trash2 className="h-3.5 w-3.5" /></Button></div></div>)}</>}
          </div>
        </section>)}
    </CardContent>
    <Dialog open={ownerDialog !== null} onOpenChange={open => !open && setOwnerDialog(null)}><DialogContent><DialogHeader><DialogTitle>{ownerDialog === "new" ? "Add owner" : "Edit owner"}</DialogTitle></DialogHeader><div className="space-y-3 py-2"><div><Label htmlFor="owner-name">Name</Label><Input id="owner-name" value={ownerForm.name} onChange={event => setOwnerForm({ ...ownerForm, name: event.target.value })} data-testid="input-owner-name" /></div><div><Label>Type</Label><Select value={ownerForm.kind} onValueChange={kind => setOwnerForm({ ...ownerForm, kind: kind as OwnerKind })}><SelectTrigger data-testid="select-owner-kind"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="person">Person</SelectItem><SelectItem value="company">Company</SelectItem></SelectContent></Select></div></div><DialogFooter><Button variant="outline" onClick={() => setOwnerDialog(null)}>Cancel</Button><Button disabled={saving || !ownerForm.name.trim()} onClick={() => void saveOwner()} data-testid="button-save-owner">Save owner</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={residencyDialog !== null} onOpenChange={open => !open && setResidencyDialog(null)}><DialogContent><DialogHeader><DialogTitle>{residencyDialog?.residency ? "Edit residency" : "Add residency"}</DialogTitle></DialogHeader><div className="grid gap-3 py-2"><div><Label htmlFor="residency-jurisdiction">Jurisdiction</Label><Input id="residency-jurisdiction" value={residencyForm.jurisdiction} onChange={event => setResidencyForm({ ...residencyForm, jurisdiction: event.target.value })} placeholder="e.g. United Kingdom" data-testid="input-residency-jurisdiction" /></div><div><Label htmlFor="residency-region">Region (optional)</Label><Input id="residency-region" value={residencyForm.region} onChange={event => setResidencyForm({ ...residencyForm, region: event.target.value })} data-testid="input-residency-region" /></div><div className="grid grid-cols-2 gap-3"><div><Label htmlFor="residency-start">Starts</Label><Input id="residency-start" type="date" value={residencyForm.startsOn} onChange={event => setResidencyForm({ ...residencyForm, startsOn: event.target.value })} data-testid="input-residency-start" /></div><div><Label htmlFor="residency-end">Ends (optional)</Label><Input id="residency-end" type="date" value={residencyForm.endsOn} onChange={event => setResidencyForm({ ...residencyForm, endsOn: event.target.value })} data-testid="input-residency-end" /></div></div><div><Label>Matching method</Label><Select value={residencyForm.matchingMethod} onValueChange={matchingMethod => setResidencyForm({ ...residencyForm, matchingMethod: matchingMethod as MatchingMethod })}><SelectTrigger data-testid="select-residency-matching"><SelectValue /></SelectTrigger><SelectContent>{methods.map(method => <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>)}</SelectContent></Select></div><div><Label htmlFor="residency-notes">Notes (optional)</Label><Input id="residency-notes" value={residencyForm.notes} onChange={event => setResidencyForm({ ...residencyForm, notes: event.target.value })} data-testid="input-residency-notes" /></div></div><DialogFooter><Button variant="outline" onClick={() => setResidencyDialog(null)}>Cancel</Button><Button disabled={saving || !residencyForm.jurisdiction.trim() || !residencyForm.startsOn} onClick={() => void saveResidency()} data-testid="button-save-residency">Save residency</Button></DialogFooter></DialogContent></Dialog>
  </Card>;
}