import { useEffect, useState } from 'react';
import { FolderInput, Loader2, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useTags } from '@/hooks/use-tags';
import {
  applyCategoryMappingDraft, getCategoryMappingDraft, getCategoryMappingItems,
  getCategoryMappingCheckpoints,
  clearCategoryMappingCheckpoint, saveCategoryMappingDraft, type CategoryMappingItem,
} from '@/lib/data/category-mapping-crud';
import type { CategoryMappingCheckpoint, CategoryMappingClassification, CategoryMappingDraftDecision } from '@/lib/db-types';

const classifications: Array<{ value: CategoryMappingClassification; label: string }> = [
  { value: 'flowType:received', label: 'Transaction · Received' }, { value: 'flowType:sent', label: 'Transaction · Sent' },
  { value: 'flowType:self-transfer', label: 'Transaction · Self-transfer' }, { value: 'flowType:consolidation', label: 'Transaction · Consolidation' },
  { value: 'acquisitionMethod:purchase', label: 'Receive · Purchase' }, { value: 'acquisitionMethod:mining', label: 'Receive · Mining' },
  { value: 'acquisitionMethod:staking', label: 'Receive · Staking/interest' }, { value: 'acquisitionMethod:airdrop', label: 'Receive · Airdrop' },
  { value: 'acquisitionMethod:fork', label: 'Receive · Fork' }, { value: 'acquisitionMethod:gift-received', label: 'Receive · Gift received' },
  { value: 'acquisitionMethod:inheritance', label: 'Receive · Inheritance' }, { value: 'acquisitionMethod:salary', label: 'Receive · Salary' },
  { value: 'acquisitionMethod:payment-for-services', label: 'Receive · Payment for services' }, { value: 'acquisitionMethod:loan', label: 'Receive · Loan' },
  { value: 'acquisitionMethod:unknown', label: 'Receive · Unknown' }, { value: 'dispositionType:sale', label: 'Send · Sale' },
  { value: 'dispositionType:payment', label: 'Send · Payment' }, { value: 'dispositionType:gift-given', label: 'Send · Gift given' },
  { value: 'dispositionType:donation', label: 'Send · Donation' }, { value: 'dispositionType:theft-loss', label: 'Send · Theft/loss' },
  { value: 'dispositionType:loan-repayment', label: 'Send · Loan repayment' }, { value: 'dispositionType:unknown', label: 'Send · Unknown' },
  { value: 'counterpartyType:exchange', label: 'Address · Exchange' }, { value: 'counterpartyType:individual', label: 'Address · Individual' },
  { value: 'counterpartyType:business', label: 'Address · Business' }, { value: 'counterpartyType:mining-pool', label: 'Address · Mining pool' },
  { value: 'counterpartyType:mixer', label: 'Address · Mixer/CoinJoin' }, { value: 'counterpartyType:unknown', label: 'Address · Unknown counterparty' },
];

export function CategoryMappingSection() {
  const { toast } = useToast();
  const { tags } = useTags();
  const [items, setItems] = useState<CategoryMappingItem[]>([]);
  const [draft, setDraft] = useState<{ [category: string]: CategoryMappingDraftDecision }>({});
  const [checkpoints, setCheckpoints] = useState<{ [category: string]: CategoryMappingCheckpoint }>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try { const [nextItems, nextDraft, nextCheckpoints] = await Promise.all([getCategoryMappingItems(), getCategoryMappingDraft(), getCategoryMappingCheckpoints()]); setItems(nextItems); setDraft(nextDraft); setCheckpoints(nextCheckpoints); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const setDecision = async (name: string, decision: CategoryMappingDraftDecision) => {
    const normalized = name.trim().toLocaleLowerCase();
    const next = { ...draft };
    for (const key of Object.keys(next)) {
      if (key.trim().toLocaleLowerCase() === normalized) delete next[key];
    }
    next[normalized] = decision;
    setDraft(next);
    await saveCategoryMappingDraft(next);
    await clearCategoryMappingCheckpoint(name);
    setCheckpoints((current) => { const nextCheckpoints = { ...current }; delete nextCheckpoints[name.trim().toLocaleLowerCase()]; return nextCheckpoints; });
  };
  const clearDecision = async (name: string) => {
    const next = { ...draft };
    for (const key of Object.keys(next)) {
      if (key.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()) delete next[key];
    }
    setDraft(next);
    await saveCategoryMappingDraft(next);
    await clearCategoryMappingCheckpoint(name);
  };
  const apply = async () => {
    setApplying(true);
    try {
      const completed = await applyCategoryMappingDraft(draft);
      const next = { ...draft };
      completed.forEach((name) => delete next[name]);
      setDraft(next);
      await saveCategoryMappingDraft(next);
      toast({ title: 'Category decisions applied', description: `${completed.length} decision${completed.length === 1 ? '' : 's'} applied.` });
      await refresh();
    } catch (error) { toast({ title: 'Could not apply category decisions', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' }); }
    finally { setApplying(false); }
  };
  return <Card data-testid="category-mapping-section">
    <CardHeader><CardTitle className="flex gap-2 items-center"><FolderInput className="h-5 w-5" />Map your categories</CardTitle>
      <CardDescription>Retire legacy categories deliberately. Choices are saved as a draft and can be changed until you apply them.</CardDescription></CardHeader>
    <CardContent className="space-y-3">
      {loading ? <div className="text-sm text-muted-foreground flex gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading categories…</div> :
        items.length === 0 ? <p className="text-sm text-muted-foreground">No categories are present on records or in vocabulary.</p> :
        items.map((item) => {
          const decision = draft[item.name] ?? draft[item.name.trim().toLocaleLowerCase()];
          const readonly = decision?.kind === 'skip';
          return <div key={item.name} className="rounded-md border p-3 space-y-2" data-testid={`category-mapping-${item.name}`}>
            <div className="flex justify-between gap-2"><span className="font-medium break-all">{item.name}</span><Badge variant="secondary">{item.usageCount} record{item.usageCount === 1 ? '' : 's'}</Badge></div>
            {readonly ? <div className="flex justify-between items-center text-sm text-muted-foreground"><span>Skipped — remains unchanged and visible read-only.</span><Button size="sm" variant="ghost" onClick={() => void clearDecision(item.name)}><RotateCcw className="mr-1 h-3 w-3" />Reconsider</Button></div> :
              <div className="grid sm:grid-cols-[150px_1fr] gap-2">
                <Select value={decision?.kind ?? ''} onValueChange={(kind) => {
                  if (kind === 'tag') void setDecision(item.name, { kind, tagName: tags[0]?.name ?? '' });
                  else if (kind === 'rename') void setDecision(item.name, { kind, categoryName: item.name });
                  else if (kind === 'classification') void setDecision(item.name, { kind, classification: classifications[0].value });
                  else void setDecision(item.name, { kind: kind as 'drop' | 'skip' });
                }}><SelectTrigger aria-label={`Decision for ${item.name}`}><SelectValue placeholder="Choose action" /></SelectTrigger><SelectContent>
                  <SelectItem value="tag">Map to tag</SelectItem><SelectItem value="rename">Rename / merge</SelectItem><SelectItem value="classification">Map classification</SelectItem><SelectItem value="drop">Drop</SelectItem><SelectItem value="skip">Skip for now</SelectItem>
                </SelectContent></Select>
                {decision?.kind === 'tag' ? <div><Label className="sr-only">Tag for {item.name}</Label><Input list="category-mapping-tags" value={decision.tagName} onChange={e => void setDecision(item.name, { ...decision, tagName: e.target.value })} placeholder="Existing or new tag" /><datalist id="category-mapping-tags">{tags.map(tag => <option key={tag.id} value={tag.name} />)}</datalist></div> : null}
                {decision?.kind === 'rename' ? <Input value={decision.categoryName} onChange={e => void setDecision(item.name, { ...decision, categoryName: e.target.value })} placeholder="Existing category merges automatically" /> : null}
                {decision?.kind === 'classification' ? <Select value={decision.classification} onValueChange={classification => void setDecision(item.name, { kind: 'classification', classification: classification as CategoryMappingClassification })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{classifications.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select> : null}
                {(decision?.kind === 'drop') && <p className="text-sm text-destructive">This removes the category from its records.</p>}
              </div>}
          </div>;
        })}
      <div className="flex justify-end"><Button disabled={applying || !Object.entries(draft).some(([name, d]) => d.kind !== 'skip' && !checkpoints[name.trim().toLocaleLowerCase()])} onClick={() => void apply()} data-testid="button-apply-category-mapping">{applying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Apply decisions</Button></div>
    </CardContent>
  </Card>;
}