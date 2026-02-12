import { useState, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  Search, 
  Edit3, 
  AlertTriangle,
  CheckCircle2,
  X,
  Undo2,
} from "lucide-react";
import { useRecords } from "@/hooks/use-records";
import { useOwners } from "@/hooks/use-owners";
import { useWalletNames } from "@/hooks/use-wallet-names";
import { useSeedNames } from "@/hooks/use-seed-names";
import { useWalletSoftware } from "@/hooks/use-wallet-software";
import { useTags } from "@/hooks/use-tags";
import { useCategories } from "@/hooks/use-categories";
import { useToast } from "@/hooks/use-toast";
import { 
  bulkUpdateRecords,
} from "@/lib/encryptionFacade";
import type { Record } from "@/lib/database";
import {
  type FieldDef,
  type Operator,
  type ActionType,
  type FilterCondition,
  type ActionDef,
  type UndoSnapshot,
  FIELD_DEFS,
  OPERATORS,
  ACTION_TYPES,
} from "./bulk-editor-types";
import { VocabularyCombobox, VocabularyMultiSelect } from "@/components/VocabularyCombobox";

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
        const operator = OPERATORS.find(o => o.value === condition.operator);
        
        // Get all condition values (multi-select) or single value
        const conditionValues = condition.values.length > 0 
          ? condition.values.map(v => v.toLowerCase())
          : condition.value ? [condition.value.toLowerCase()] : [];
        
        // If operator needs a value but none provided, don't match anything
        // This prevents empty selections from matching all records
        if (operator?.needsValue && conditionValues.length === 0) {
          return false;
        }
        
        // Handle array fields (tags, categories)
        if (fieldDef.type === 'array') {
          const arr = (fieldValue as string[] | undefined) || [];
          const arrLower = arr.map(v => v.toLowerCase());
          
          switch (condition.operator) {
            case 'contains':
              // For multi-select: match if ANY of the condition values are in the array
              return conditionValues.some(cv => arrLower.some(v => v.includes(cv)));
            case 'not_contains':
              return !conditionValues.some(cv => arrLower.some(v => v.includes(cv)));
            case 'equals':
              // For multi-select: match if the field value equals ANY of the selected values
              return conditionValues.some(cv => arrLower.includes(cv));
            case 'not_equals':
              return !conditionValues.some(cv => arrLower.includes(cv));
            case 'is_empty':
              return arr.length === 0;
            case 'is_not_empty':
              return arr.length > 0;
            default:
              return false;
          }
        }
        
        // Handle string/enum/select fields
        const strValue = (fieldValue as string | undefined)?.toLowerCase() || '';
        
        switch (condition.operator) {
          case 'equals':
            // For multi-select: match if the field value equals ANY of the selected values
            return conditionValues.includes(strValue);
          case 'not_equals':
            return !conditionValues.includes(strValue);
          case 'contains':
            return conditionValues.some(cv => strValue.includes(cv));
          case 'not_contains':
            return !conditionValues.some(cv => strValue.includes(cv));
          case 'starts_with':
            return conditionValues.some(cv => strValue.startsWith(cv));
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
      values: [],
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
  
  // Apply actions to matching records (optimized batch processing)
  const applyChanges = async () => {
    if (!isValidSetup || matchingRecords.length === 0) return;
    
    setIsApplying(true);
    
    try {
      // Create undo snapshot with detailed info for clear undo messaging
      const snapshot: UndoSnapshot = {
        timestamp: Date.now(),
        recordSnapshots: [],
        description: `Bulk edit: ${actions.length} action(s) on ${matchingRecords.length} record(s)`,
        recordCount: matchingRecords.length,
        actionsApplied: actions.map(a => ({
          type: a.type,
          field: FIELD_DEFS.find(f => f.key === a.field)?.label || a.field as string,
          value: a.type !== 'clear' ? a.value : undefined,
        })),
      };
      
      // Step 1: Compute all updates in memory
      const bulkUpdates: Array<{ id: number; changes: Partial<Record> }> = [];
      
      for (const record of matchingRecords) {
        // Build the update object for this record
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
        
        // Add to undo snapshot
        snapshot.recordSnapshots.push({
          id: record.id!,
          before: beforeState,
        });
        
        // Add to bulk updates if there are changes
        if (Object.keys(updates).length > 0) {
          bulkUpdates.push({ id: record.id!, changes: updates });
        }
      }
      
      // Step 2: Apply all updates in a single batch operation
      const { successCount, errorCount } = await bulkUpdateRecords(bulkUpdates);
      
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
  
  // Undo last bulk edit (also uses batch processing)
  const undoChanges = async () => {
    if (!lastUndo) return;
    
    setIsApplying(true);
    
    try {
      // Convert undo snapshots to bulk update format
      const undoUpdates = lastUndo.recordSnapshots.map(snapshot => ({
        id: snapshot.id,
        changes: snapshot.before,
      }));
      
      const { successCount } = await bulkUpdateRecords(undoUpdates);
      
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
  
  // Render filter value input with multi-select support for vocabulary fields
  const renderFilterValueInput = (
    condition: FilterCondition,
    updateFn: (updates: Partial<FilterCondition>) => void
  ) => {
    const fieldDef = FIELD_DEFS.find(f => f.key === condition.field);
    if (!fieldDef) return null;
    
    const options = getFieldOptions(fieldDef);
    
    // For enum fields (fixed options), use multi-select
    if (fieldDef.type === 'enum' && options.length > 0) {
      return (
        <VocabularyMultiSelect
          fieldKey={condition.field as string}
          values={condition.values}
          onChange={(v) => updateFn({ values: v, value: v[0] || '' })}
          options={options}
          placeholder="Select values..."
        />
      );
    }
    
    // For vocabulary fields (select/array with suggestions), use VocabularyMultiSelect
    if ((fieldDef.type === 'select' || fieldDef.type === 'array') && fieldDef.vocabularyKey) {
      const optionsHash = options.map(o => o.value).join('|').slice(0, 100);
      return (
        <VocabularyMultiSelect
          key={`${condition.field}-${optionsHash}`}
          fieldKey={condition.field as string}
          values={condition.values}
          onChange={(v) => updateFn({ values: v, value: v[0] || '' })}
          options={options}
          placeholder="Select values..."
          vocabularyKey={fieldDef.vocabularyKey}
        />
      );
    }
    
    // For text fields, use plain Input (single value only)
    return (
      <Input
        value={condition.value}
        onChange={e => updateFn({ value: e.target.value, values: e.target.value ? [e.target.value] : [] })}
        placeholder="Enter value..."
        className="w-[180px]"
        data-testid={`input-filter-value-${condition.field}`}
      />
    );
  };
  
  // Render field value input (text, select, or combobox)
  const renderValueInput = (
    fieldKey: keyof Record, 
    value: string, 
    onChange: (value: string) => void,
    placeholder: string = "Enter value..."
  ) => {
    const fieldDef = FIELD_DEFS.find(f => f.key === fieldKey);
    if (!fieldDef) return null;
    
    const options = getFieldOptions(fieldDef);
    
    // For enum fields (fixed options), use Select
    if (fieldDef.type === 'enum' && options.length > 0) {
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
    
    // For vocabulary fields (select/array with suggestions), use Combobox
    // Key includes hash of option values to force re-render when vocabulary data changes (encrypted → decrypted)
    if ((fieldDef.type === 'select' || fieldDef.type === 'array') && fieldDef.vocabularyKey) {
      // Create a simple hash from option values to detect content changes
      const optionsHash = options.map(o => o.value).join('|').slice(0, 100);
      return (
        <VocabularyCombobox
          key={`${fieldKey}-${optionsHash}`}
          fieldKey={fieldKey as string}
          value={value}
          onChange={onChange}
          options={options}
          placeholder={placeholder}
          vocabularyKey={fieldDef.vocabularyKey}
        />
      );
    }
    
    // For text fields, use plain Input
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
    <div className="h-full overflow-auto">
      <div className="container mx-auto p-6 max-w-6xl space-y-6 pb-12">
        <div className="flex items-center justify-between flex-wrap gap-2">
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
            <Popover>
              <PopoverTrigger asChild>
                <Button 
                  variant="outline" 
                  disabled={isApplying}
                  data-testid="button-undo"
                >
                  <Undo2 className="h-4 w-4 mr-2" />
                  Undo Available
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="space-y-3">
                  <div>
                    <h4 className="font-medium text-sm">Undo Last Bulk Edit</h4>
                    <p className="text-xs text-muted-foreground mt-1">
                      This will restore {lastUndo.recordCount} record{lastUndo.recordCount !== 1 ? 's' : ''} to their previous state.
                    </p>
                  </div>
                  
                  <div className="text-xs space-y-1">
                    <div className="font-medium text-muted-foreground">Actions that were applied:</div>
                    {lastUndo.actionsApplied.map((action, i) => (
                      <div key={i} className="flex items-center gap-2 pl-2">
                        <Badge variant="outline" className="text-xs shrink-0">
                          {action.type === 'set' ? 'Set' : 
                           action.type === 'add' ? 'Add' : 
                           action.type === 'remove' ? 'Remove' : 'Clear'}
                        </Badge>
                        <span>{action.field}</span>
                        {action.value && <span className="text-muted-foreground">= "{action.value}"</span>}
                      </div>
                    ))}
                  </div>
                  
                  <div className="text-xs text-muted-foreground">
                    Performed {new Date(lastUndo.timestamp).toLocaleTimeString()}
                  </div>
                  
                  <div className="flex justify-end gap-2 pt-2 border-t">
                    <Button 
                      size="sm" 
                      onClick={undoChanges}
                      disabled={isApplying}
                    >
                      <Undo2 className="h-3 w-3 mr-1" />
                      Undo Changes
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
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
          {/* Logic toggle with clear explanation */}
          {conditions.length > 1 && (
            <div className="p-3 bg-muted/50 rounded-lg space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
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
              <p className="text-xs text-muted-foreground">
                {useAndLogic 
                  ? "ALL mode: Records must match every condition below (narrower results)"
                  : "ANY mode: Records need to match just one condition below (broader results)"
                }
              </p>
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
                  
                  {/* Value input - multi-select for vocabulary/enum fields */}
                  {operator?.needsValue && (
                    renderFilterValueInput(
                      condition,
                      (updates) => updateCondition(condition.id, updates)
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
            What changes should be applied to matching records? Actions run in order from top to bottom.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Action Examples - collapsible help section */}
          <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg space-y-2">
            <div className="font-medium text-foreground">How actions work:</div>
            <div className="grid gap-1.5">
              <div>
                <Badge variant="outline" className="text-xs mr-2">Add</Badge>
                <span>Keeps existing values, adds new one. <span className="text-muted-foreground/70 italic">Ex: Tags [Work] + Add "Personal" = [Work, Personal]</span></span>
              </div>
              <div>
                <Badge variant="outline" className="text-xs mr-2">Set</Badge>
                <span>Replaces value completely. <span className="text-muted-foreground/70 italic">Ex: Tags [Work, Old] + Set "New" = [New]</span></span>
              </div>
              <div>
                <Badge variant="outline" className="text-xs mr-2">Remove</Badge>
                <span>Removes specific value, keeps others. <span className="text-muted-foreground/70 italic">Ex: Tags [Work, Personal] + Remove "Work" = [Personal]</span></span>
              </div>
              <div>
                <Badge variant="outline" className="text-xs mr-2">Clear</Badge>
                <span>Removes all values from field. <span className="text-muted-foreground/70 italic">Ex: Tags [Work, Personal] + Clear = [ ]</span></span>
              </div>
            </div>
          </div>
          
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
                  {/* Field selector - comes first so action types update accordingly */}
                  <Select
                    value={action.field as string}
                    onValueChange={(v) => {
                      const newFieldDef = FIELD_DEFS.find(f => f.key === v);
                      const newIsArray = newFieldDef?.type === 'array';
                      // Reset action type if incompatible, or default to 'add' for array fields
                      let newType = action.type;
                      if (newIsArray && (action.type === 'set' || action.type === 'clear')) {
                        newType = 'add'; // Default to 'add' for array fields
                      } else if (!newIsArray && (action.type === 'add' || action.type === 'remove')) {
                        newType = 'set'; // Default to 'set' for singular fields
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
                  
                  {/* Action type - comes after field so options are contextual */}
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
      
      {/* Confirmation Dialog - Detailed Review */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              Review & Confirm Changes
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 text-left">
                {/* Summary Stats */}
                <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg">
                  <div className="text-center px-4 py-2 border-r">
                    <div className="text-2xl font-bold text-primary">{matchingRecords.length}</div>
                    <div className="text-xs text-muted-foreground">Record{matchingRecords.length !== 1 ? 's' : ''}</div>
                  </div>
                  <div className="text-center px-4 py-2">
                    <div className="text-2xl font-bold text-primary">{actions.length}</div>
                    <div className="text-xs text-muted-foreground">Action{actions.length !== 1 ? 's' : ''}</div>
                  </div>
                </div>
                
                {/* Actions Summary */}
                <div>
                  <h4 className="font-medium mb-2 text-sm text-foreground">Changes to Apply:</h4>
                  <div className="bg-muted rounded-lg p-3 space-y-2">
                    {actions.map((action, i) => {
                      const fieldDef = FIELD_DEFS.find(f => f.key === action.field);
                      const actionLabels: { [key: string]: string } = {
                        'set': 'Set',
                        'add': 'Add to',
                        'remove': 'Remove from',
                        'clear': 'Clear',
                      };
                      return (
                        <div key={action.id} className="flex items-start gap-2 text-sm">
                          <Badge variant="outline" className="shrink-0 text-xs">
                            {i + 1}
                          </Badge>
                          <div>
                            <span className="font-medium">{actionLabels[action.type]}</span>{' '}
                            <span className="text-muted-foreground">{fieldDef?.label}</span>
                            {action.type !== 'clear' && (
                              <span className="text-primary"> → "{action.value}"</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                
                {/* Preview of Changes */}
                <div>
                  <h4 className="font-medium mb-2 text-sm text-foreground">Preview of Affected Records:</h4>
                  <div className="border rounded-lg max-h-[200px] overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 sticky top-0">
                        <tr>
                          <th className="text-left p-2 font-medium">Record</th>
                          {actions.map(action => {
                            const fieldDef = FIELD_DEFS.find(f => f.key === action.field);
                            return (
                              <th key={action.id} className="text-left p-2 font-medium">
                                {fieldDef?.label}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {matchingRecords.slice(0, 5).map((record, idx) => (
                          <tr key={record.id} className={idx % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                            <td className="p-2 font-mono text-xs truncate max-w-[150px]">
                              {record.inputString?.substring(0, 20)}...
                            </td>
                            {actions.map(action => {
                              const currentValue = record[action.field];
                              const displayCurrent = Array.isArray(currentValue) 
                                ? (currentValue as string[]).join(', ') || '(empty)'
                                : (currentValue as string) || '(empty)';
                              
                              // Compute new value
                              let newValue = displayCurrent;
                              if (action.type === 'set') {
                                newValue = action.value || '(empty)';
                              } else if (action.type === 'clear') {
                                newValue = '(empty)';
                              } else if (action.type === 'add' && Array.isArray(currentValue)) {
                                const arr = (currentValue as string[]) || [];
                                newValue = arr.includes(action.value) 
                                  ? arr.join(', ')
                                  : [...arr, action.value].join(', ');
                              } else if (action.type === 'remove' && Array.isArray(currentValue)) {
                                const arr = (currentValue as string[]).filter(v => v !== action.value);
                                newValue = arr.join(', ') || '(empty)';
                              }
                              
                              const changed = displayCurrent !== newValue;
                              
                              return (
                                <td key={action.id} className="p-2">
                                  {changed ? (
                                    <div className="space-y-1">
                                      <div className="text-muted-foreground line-through text-xs truncate max-w-[100px]">
                                        {displayCurrent}
                                      </div>
                                      <div className="text-primary font-medium text-xs truncate max-w-[100px]">
                                        {newValue}
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground text-xs">
                                      {displayCurrent}
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {matchingRecords.length > 5 && (
                      <div className="text-center text-xs text-muted-foreground py-2 bg-muted/30 border-t">
                        ...and {matchingRecords.length - 5} more record{matchingRecords.length - 5 !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </div>
                
                {/* Undo notice */}
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/30 p-3 rounded-lg">
                  <Undo2 className="h-4 w-4 shrink-0" />
                  <span>After applying, an "Undo Available" button will appear at the top. Click it to see details and restore records.</span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row gap-2 sm:justify-between">
            <AlertDialogCancel data-testid="button-cancel-confirm" className="mt-0">
              <X className="h-4 w-4 mr-2" />
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction 
              onClick={applyChanges} 
              data-testid="button-confirm-apply"
              disabled={isApplying}
            >
              {isApplying ? (
                "Applying..."
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Confirm & Apply
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  );
}
