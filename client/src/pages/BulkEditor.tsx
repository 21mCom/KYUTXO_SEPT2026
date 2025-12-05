import { useState, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  Filter, 
  Plus, 
  Trash2, 
  Search, 
  Edit3, 
  AlertTriangle,
  CheckCircle2,
  X,
  Undo2
} from "lucide-react";
import { useRecords } from "@/hooks/use-records";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useToast } from "@/hooks/use-toast";
import { updateRecord } from "@/lib/encryptionFacade";
import type { 
  Record, 
  AddressImportance, 
  FlowType, 
  CounterpartyType,
  ChainType 
} from "@/lib/database";
import {
  FLOW_TYPE_OPTIONS,
  COUNTERPARTY_TYPE_OPTIONS,
} from "@/lib/database";

// Field definitions for filter/action builders
type FieldType = 'text' | 'select' | 'array' | 'enum';

interface FieldDef {
  key: keyof Record;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  vocabularyKey?: 'owners' | 'walletNames' | 'seedNames' | 'walletSoftware' | 'tags' | 'categories';
}

const ADDRESS_IMPORTANCE_OPTIONS = [
  { value: 'verified', label: 'Verified' },
  { value: 'manual', label: 'Manual' },
  { value: 'wallet-import', label: 'Wallet Import' },
  { value: 'xpub-derived', label: 'XPUB Derived' },
  { value: 'blockchain-discovered', label: 'Blockchain Discovered' },
  { value: 'pending-review', label: 'Pending Review' },
];

const CHAIN_TYPE_OPTIONS = [
  { value: 'receive', label: 'Receive (External)' },
  { value: 'change', label: 'Change (Internal)' },
];

const TYPE_OPTIONS = [
  { value: 'address', label: 'Address' },
  { value: 'transaction', label: 'Transaction' },
  { value: 'other', label: 'Other' },
];

const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'xpub-import', label: 'XPUB Import' },
  { value: 'wallet-import', label: 'Wallet Import' },
  { value: 'blockchain-sync', label: 'Blockchain Sync' },
];

// Base field definitions (vocabulary options added dynamically)
const FIELD_DEFS: FieldDef[] = [
  { key: 'type', label: 'Type', type: 'enum', options: TYPE_OPTIONS },
  { key: 'owner', label: 'Owner', type: 'select', vocabularyKey: 'owners' },
  { key: 'walletName', label: 'Wallet Name', type: 'select', vocabularyKey: 'walletNames' },
  { key: 'seedName', label: 'Seed Name', type: 'select', vocabularyKey: 'seedNames' },
  { key: 'walletSoftware', label: 'Wallet Software', type: 'select', vocabularyKey: 'walletSoftware' },
  { key: 'tags', label: 'Tags', type: 'array', vocabularyKey: 'tags' },
  { key: 'categories', label: 'Categories', type: 'array', vocabularyKey: 'categories' },
  { key: 'label', label: 'Label', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'text' },
  { key: 'source', label: 'Source', type: 'enum', options: SOURCE_OPTIONS },
  { key: 'chainType', label: 'Chain Type', type: 'enum', options: CHAIN_TYPE_OPTIONS },
  { key: 'addressImportance', label: 'Address Importance', type: 'enum', options: ADDRESS_IMPORTANCE_OPTIONS },
  { key: 'flowType', label: 'Flow Type', type: 'enum', options: FLOW_TYPE_OPTIONS },
  { key: 'counterpartyType', label: 'Counterparty Type', type: 'enum', options: COUNTERPARTY_TYPE_OPTIONS },
];

// Filter operators
type Operator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'is_empty' | 'is_not_empty';

const OPERATORS: { value: Operator; label: string; needsValue: boolean }[] = [
  { value: 'equals', label: 'equals', needsValue: true },
  { value: 'not_equals', label: 'does not equal', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true },
  { value: 'is_empty', label: 'is empty', needsValue: false },
  { value: 'is_not_empty', label: 'is not empty', needsValue: false },
];

// Action types
type ActionType = 'set' | 'add' | 'remove' | 'clear';

const ACTION_TYPES: { value: ActionType; label: string; description: string }[] = [
  { value: 'set', label: 'Set', description: 'Replace the value' },
  { value: 'add', label: 'Add', description: 'Add to array (tags/categories)' },
  { value: 'remove', label: 'Remove', description: 'Remove from array (tags/categories)' },
  { value: 'clear', label: 'Clear', description: 'Set to empty' },
];

// Filter condition
interface FilterCondition {
  id: string;
  field: keyof Record;
  operator: Operator;
  value: string;
}

// Action definition
interface ActionDef {
  id: string;
  type: ActionType;
  field: keyof Record;
  value: string;
}

// Undo snapshot
interface UndoSnapshot {
  timestamp: number;
  recordSnapshots: { id: number; before: Partial<Record> }[];
  description: string;
}

export default function BulkEditor() {
  const { records, isLoading } = useRecords();
  const { owners } = useOwners();
  const { walletNames } = useWalletNames();
  const { seedNames } = useSeedNames();
  const { walletSoftware } = useWalletSoftware();
  const { tags } = useTags();
  const { categories } = useCategories();
  const { toast } = useToast();
  
  // Filter state
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [useAndLogic, setUseAndLogic] = useState(true);
  
  // Action state
  const [actions, setActions] = useState<ActionDef[]>([]);
  
  // UI state
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [lastUndo, setLastUndo] = useState<UndoSnapshot | null>(null);
  
  // Build vocabulary options map
  const vocabularyOptions = useMemo(() => ({
    owners: owners.map(o => ({ value: o.name, label: o.name })),
    walletNames: walletNames.map(w => ({ value: w.name, label: w.name })),
    seedNames: seedNames.map(s => ({ value: s.name, label: s.name })),
    walletSoftware: walletSoftware.map(w => ({ value: w.name, label: w.name })),
    tags: tags.map(t => ({ value: t.name, label: t.name })),
    categories: categories.map(c => ({ value: c.name, label: c.name })),
  }), [owners, walletNames, seedNames, walletSoftware, tags, categories]);
  
  // Get options for a field
  const getFieldOptions = (field: FieldDef) => {
    if (field.options) return field.options;
    if (field.vocabularyKey) return vocabularyOptions[field.vocabularyKey];
    return [];
  };
  
  // Filter records based on conditions
  const matchingRecords = useMemo(() => {
    if (conditions.length === 0) return [];
    
    return records.filter(record => {
      const results = conditions.map(condition => {
        const fieldDef = FIELD_DEFS.find(f => f.key === condition.field);
        if (!fieldDef) return false;
        
        const fieldValue = record[condition.field];
        const conditionValue = condition.value.toLowerCase();
        
        // Handle array fields (tags, categories)
        if (fieldDef.type === 'array') {
          const arr = (fieldValue as string[] | undefined) || [];
          const arrLower = arr.map(v => v.toLowerCase());
          
          switch (condition.operator) {
            case 'contains':
              return arrLower.some(v => v.includes(conditionValue));
            case 'not_contains':
              return !arrLower.some(v => v.includes(conditionValue));
            case 'equals':
              return arrLower.includes(conditionValue);
            case 'not_equals':
              return !arrLower.includes(conditionValue);
            case 'is_empty':
              return arr.length === 0;
            case 'is_not_empty':
              return arr.length > 0;
            default:
              return false;
          }
        }
        
        // Handle string/enum fields
        const strValue = (fieldValue as string | undefined)?.toLowerCase() || '';
        
        switch (condition.operator) {
          case 'equals':
            return strValue === conditionValue;
          case 'not_equals':
            return strValue !== conditionValue;
          case 'contains':
            return strValue.includes(conditionValue);
          case 'not_contains':
            return !strValue.includes(conditionValue);
          case 'starts_with':
            return strValue.startsWith(conditionValue);
          case 'is_empty':
            return !strValue || strValue === '';
          case 'is_not_empty':
            return strValue && strValue !== '';
          default:
            return false;
        }
      });
      
      return useAndLogic 
        ? results.every(r => r) 
        : results.some(r => r);
    });
  }, [records, conditions, useAndLogic]);
  
  // Add a new filter condition
  const addCondition = () => {
    setConditions([...conditions, {
      id: crypto.randomUUID(),
      field: 'owner',
      operator: 'equals',
      value: '',
    }]);
  };
  
  // Update a condition
  const updateCondition = (id: string, updates: Partial<FilterCondition>) => {
    setConditions(conditions.map(c => 
      c.id === id ? { ...c, ...updates } : c
    ));
  };
  
  // Remove a condition
  const removeCondition = (id: string) => {
    setConditions(conditions.filter(c => c.id !== id));
  };
  
  // Add a new action
  const addAction = () => {
    setActions([...actions, {
      id: crypto.randomUUID(),
      type: 'set',
      field: 'owner',
      value: '',
    }]);
  };
  
  // Update an action
  const updateAction = (id: string, updates: Partial<ActionDef>) => {
    setActions(actions.map(a => 
      a.id === id ? { ...a, ...updates } : a
    ));
  };
  
  // Remove an action
  const removeAction = (id: string) => {
    setActions(actions.filter(a => a.id !== id));
  };
  
  // Check if actions are valid
  const isValidSetup = conditions.length > 0 && actions.length > 0 && 
    actions.every(a => {
      if (a.type === 'clear') return true;
      return a.value.trim() !== '';
    });
  
  // Apply actions to matching records
  const applyChanges = async () => {
    if (!isValidSetup || matchingRecords.length === 0) return;
    
    setIsApplying(true);
    
    try {
      // Create undo snapshot
      const snapshot: UndoSnapshot = {
        timestamp: Date.now(),
        recordSnapshots: [],
        description: `Bulk edit: ${actions.length} action(s) on ${matchingRecords.length} record(s)`,
      };
      
      let successCount = 0;
      let errorCount = 0;
      
      for (const record of matchingRecords) {
        try {
          // Build the update object
          const updates: Partial<Record> = {};
          const beforeState: Partial<Record> = {};
          
          for (const action of actions) {
            const fieldDef = FIELD_DEFS.find(f => f.key === action.field);
            if (!fieldDef) continue;
            
            // Store before state for undo (only store original value, not intermediate)
            if (!(action.field in beforeState)) {
              beforeState[action.field] = record[action.field] as any;
            }
            
            if (fieldDef.type === 'array') {
              // Use the accumulated value if already modified, otherwise use original
              const currentArray = (action.field in updates) 
                ? ((updates as any)[action.field] as string[] || [])
                : ((record[action.field] as string[] | undefined) || []);
              
              switch (action.type) {
                case 'add':
                  if (!currentArray.includes(action.value)) {
                    (updates as any)[action.field] = [...currentArray, action.value];
                  } else {
                    // Preserve current state even if value already exists
                    (updates as any)[action.field] = currentArray;
                  }
                  break;
                case 'remove':
                  (updates as any)[action.field] = currentArray.filter(v => v !== action.value);
                  break;
                case 'set':
                  (updates as any)[action.field] = action.value ? [action.value] : [];
                  break;
                case 'clear':
                  (updates as any)[action.field] = [];
                  break;
              }
            } else {
              // Use the accumulated value if already modified, otherwise use original
              const currentValue = (action.field in updates)
                ? (updates as any)[action.field]
                : (record[action.field] as string | undefined) || '';
              
              switch (action.type) {
                case 'set':
                  (updates as any)[action.field] = action.value;
                  break;
                case 'clear':
                  (updates as any)[action.field] = '';
                  break;
                default:
                  // add/remove not valid for non-array fields, preserve current
                  (updates as any)[action.field] = currentValue;
                  break;
              }
            }
          }
          
          // Save snapshot for undo
          snapshot.recordSnapshots.push({
            id: record.id!,
            before: beforeState,
          });
          
          // Apply the update
          if (Object.keys(updates).length > 0) {
            await updateRecord(record.id!, updates);
            successCount++;
          }
        } catch (error) {
          console.error(`Failed to update record ${record.id}:`, error);
          errorCount++;
        }
      }
      
      // Store undo snapshot
      setLastUndo(snapshot);
      
      toast({
        title: "Bulk Edit Complete",
        description: `Updated ${successCount} record(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
      });
      
      // Reset actions but keep filters for follow-up edits
      setActions([]);
      
    } catch (error) {
      console.error('Bulk edit failed:', error);
      toast({
        title: "Bulk Edit Failed",
        description: "An error occurred while applying changes",
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
      setShowConfirmDialog(false);
    }
  };
  
  // Undo last bulk edit
  const undoChanges = async () => {
    if (!lastUndo) return;
    
    setIsApplying(true);
    
    try {
      let successCount = 0;
      
      for (const snapshot of lastUndo.recordSnapshots) {
        try {
          await updateRecord(snapshot.id, snapshot.before);
          successCount++;
        } catch (error) {
          console.error(`Failed to undo record ${snapshot.id}:`, error);
        }
      }
      
      toast({
        title: "Undo Complete",
        description: `Restored ${successCount} record(s) to previous state`,
      });
      
      setLastUndo(null);
    } catch (error) {
      console.error('Undo failed:', error);
      toast({
        title: "Undo Failed",
        description: "An error occurred while undoing changes",
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
    }
  };
  
  // Render field value input (text or select)
  const renderValueInput = (
    fieldKey: keyof Record, 
    value: string, 
    onChange: (value: string) => void,
    placeholder: string = "Enter value..."
  ) => {
    const fieldDef = FIELD_DEFS.find(f => f.key === fieldKey);
    if (!fieldDef) return null;
    
    const options = getFieldOptions(fieldDef);
    
    if (options.length > 0) {
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-[180px]" data-testid={`select-value-${fieldKey}`}>
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    
    return (
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-[180px]"
        data-testid={`input-value-${fieldKey}`}
      />
    );
  };
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading records...</div>
      </div>
    );
  }
  
  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Edit3 className="h-6 w-6" />
            Bulk Editor
          </h1>
          <p className="text-muted-foreground mt-1">
            Find and update multiple records at once
          </p>
        </div>
        
        {lastUndo && (
          <Button 
            variant="outline" 
            onClick={undoChanges}
            disabled={isApplying}
            data-testid="button-undo"
          >
            <Undo2 className="h-4 w-4 mr-2" />
            Undo Last Edit
          </Button>
        )}
      </div>
      
      {/* Step 1: Filter Builder */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Step 1: Find Records
          </CardTitle>
          <CardDescription>
            Define criteria to find records you want to edit
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Logic toggle */}
          {conditions.length > 1 && (
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <Label className="text-sm">Match records where:</Label>
              <div className="flex items-center gap-2">
                <span className={!useAndLogic ? "font-medium" : "text-muted-foreground"}>ANY</span>
                <Switch
                  checked={useAndLogic}
                  onCheckedChange={setUseAndLogic}
                  data-testid="switch-logic"
                />
                <span className={useAndLogic ? "font-medium" : "text-muted-foreground"}>ALL</span>
              </div>
              <span className="text-sm text-muted-foreground">conditions match</span>
            </div>
          )}
          
          {/* Conditions */}
          <div className="space-y-3">
            {conditions.map((condition, index) => {
              const fieldDef = FIELD_DEFS.find(f => f.key === condition.field);
              const operator = OPERATORS.find(o => o.value === condition.operator);
              
              return (
                <div key={condition.id} className="flex items-center gap-2 flex-wrap">
                  {index > 0 && (
                    <Badge variant="outline" className="text-xs">
                      {useAndLogic ? 'AND' : 'OR'}
                    </Badge>
                  )}
                  
                  {/* Field selector */}
                  <Select
                    value={condition.field as string}
                    onValueChange={(v) => updateCondition(condition.id, { field: v as keyof Record })}
                  >
                    <SelectTrigger className="w-[160px]" data-testid={`select-field-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_DEFS.map(f => (
                        <SelectItem key={f.key as string} value={f.key as string}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {/* Operator selector */}
                  <Select
                    value={condition.operator}
                    onValueChange={(v) => updateCondition(condition.id, { operator: v as Operator })}
                  >
                    <SelectTrigger className="w-[150px]" data-testid={`select-operator-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPERATORS.map(o => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {/* Value input */}
                  {operator?.needsValue && (
                    renderValueInput(
                      condition.field,
                      condition.value,
                      (v) => updateCondition(condition.id, { value: v }),
                      "Select or type..."
                    )
                  )}
                  
                  {/* Remove button */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeCondition(condition.id)}
                    data-testid={`button-remove-condition-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          
          {/* Add condition button */}
          <Button 
            variant="outline" 
            onClick={addCondition}
            data-testid="button-add-condition"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Condition
          </Button>
          
          {/* Match count */}
          {conditions.length > 0 && (
            <Alert className={matchingRecords.length > 0 ? "" : "border-amber-500"}>
              <Search className="h-4 w-4" />
              <AlertTitle>
                {matchingRecords.length} record{matchingRecords.length !== 1 ? 's' : ''} match
              </AlertTitle>
              <AlertDescription>
                {matchingRecords.length === 0 
                  ? "No records match your criteria. Try adjusting the filters."
                  : `Found ${matchingRecords.length} of ${records.length} total records`
                }
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      
      {/* Step 2: Actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Edit3 className="h-5 w-5" />
            Step 2: Define Changes
          </CardTitle>
          <CardDescription>
            What changes should be applied to matching records?
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Actions */}
          <div className="space-y-3">
            {actions.map((action, index) => {
              const fieldDef = FIELD_DEFS.find(f => f.key === action.field);
              const isArrayField = fieldDef?.type === 'array';
              const showValue = action.type !== 'clear';
              
              // Filter action types based on field type
              const availableActions = ACTION_TYPES.filter(at => {
                if (at.value === 'add' || at.value === 'remove') {
                  return isArrayField;
                }
                return true;
              });
              
              return (
                <div key={action.id} className="flex items-center gap-2 flex-wrap">
                  {/* Action type */}
                  <Select
                    value={action.type}
                    onValueChange={(v) => updateAction(action.id, { type: v as ActionType })}
                  >
                    <SelectTrigger className="w-[120px]" data-testid={`select-action-type-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableActions.map(at => (
                        <SelectItem key={at.value} value={at.value}>
                          {at.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {/* Field selector */}
                  <Select
                    value={action.field as string}
                    onValueChange={(v) => {
                      const newFieldDef = FIELD_DEFS.find(f => f.key === v);
                      const newIsArray = newFieldDef?.type === 'array';
                      // Reset action type if incompatible
                      let newType = action.type;
                      if (!newIsArray && (action.type === 'add' || action.type === 'remove')) {
                        newType = 'set';
                      }
                      updateAction(action.id, { field: v as keyof Record, type: newType });
                    }}
                  >
                    <SelectTrigger className="w-[160px]" data-testid={`select-action-field-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_DEFS.map(f => (
                        <SelectItem key={f.key as string} value={f.key as string}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  
                  {/* Value input */}
                  {showValue && (
                    <>
                      <span className="text-muted-foreground">=</span>
                      {renderValueInput(
                        action.field,
                        action.value,
                        (v) => updateAction(action.id, { value: v }),
                        "New value..."
                      )}
                    </>
                  )}
                  
                  {/* Remove button */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeAction(action.id)}
                    data-testid={`button-remove-action-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          
          {/* Add action button */}
          <Button 
            variant="outline" 
            onClick={addAction}
            data-testid="button-add-action"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Action
          </Button>
        </CardContent>
      </Card>
      
      {/* Step 3: Preview & Apply */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5" />
            Step 3: Preview & Apply
          </CardTitle>
          <CardDescription>
            Review the records that will be modified
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Preview of matching records */}
          {matchingRecords.length > 0 && (
            <div className="border rounded-lg">
              <div className="p-3 bg-muted/50 border-b flex items-center justify-between">
                <span className="font-medium text-sm">
                  Preview: {matchingRecords.length} record{matchingRecords.length !== 1 ? 's' : ''} will be modified
                </span>
              </div>
              <ScrollArea className="h-[200px]">
                <div className="p-3 space-y-2">
                  {matchingRecords.slice(0, 50).map(record => (
                    <div 
                      key={record.id} 
                      className="flex items-center gap-3 p-2 bg-background rounded border text-sm"
                    >
                      <Badge variant="outline" className="shrink-0">
                        {record.type}
                      </Badge>
                      <span className="font-mono text-xs truncate flex-1">
                        {record.inputString?.substring(0, 40)}...
                      </span>
                      {record.owner && (
                        <Badge variant="secondary" className="shrink-0">
                          {record.owner}
                        </Badge>
                      )}
                      {record.label && (
                        <span className="text-muted-foreground truncate max-w-[150px]">
                          {record.label}
                        </span>
                      )}
                    </div>
                  ))}
                  {matchingRecords.length > 50 && (
                    <div className="text-center text-sm text-muted-foreground py-2">
                      ...and {matchingRecords.length - 50} more
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          )}
          
          {/* Validation warnings */}
          {conditions.length === 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>No filters defined</AlertTitle>
              <AlertDescription>
                Add at least one filter condition to find records to edit.
              </AlertDescription>
            </Alert>
          )}
          
          {conditions.length > 0 && actions.length === 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>No actions defined</AlertTitle>
              <AlertDescription>
                Add at least one action to apply to matching records.
              </AlertDescription>
            </Alert>
          )}
          
          {/* Apply button */}
          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => {
                setConditions([]);
                setActions([]);
              }}
              disabled={conditions.length === 0 && actions.length === 0}
              data-testid="button-reset"
            >
              Reset All
            </Button>
            <Button
              onClick={() => setShowConfirmDialog(true)}
              disabled={!isValidSetup || matchingRecords.length === 0 || isApplying}
              data-testid="button-apply"
            >
              {isApplying ? "Applying..." : `Apply to ${matchingRecords.length} Record${matchingRecords.length !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </CardContent>
      </Card>
      
      {/* Confirmation Dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Bulk Edit</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                You are about to apply <strong>{actions.length}</strong> action{actions.length !== 1 ? 's' : ''} to{' '}
                <strong>{matchingRecords.length}</strong> record{matchingRecords.length !== 1 ? 's' : ''}.
              </p>
              <div className="bg-muted p-3 rounded-lg space-y-1 text-sm">
                {actions.map((action, i) => {
                  const fieldDef = FIELD_DEFS.find(f => f.key === action.field);
                  return (
                    <div key={action.id}>
                      {i + 1}. <strong>{action.type.toUpperCase()}</strong> {fieldDef?.label}
                      {action.type !== 'clear' && ` = "${action.value}"`}
                    </div>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">
                You can undo this action after it completes.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-confirm">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={applyChanges} data-testid="button-confirm-apply">
              Apply Changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
