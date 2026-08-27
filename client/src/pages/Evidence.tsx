import { useState, useCallback } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PAGE_DEBOUNCE } from "@/config/debounce";
import { useLiveQuery } from "dexie-react-hooks";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { 
  Plus, 
  Search, 
  FileText, 
  Calendar, 
  Tag, 
  Users, 
  Download,
  Trash2,
  Edit2,
  Filter,
  X,
  Upload,
  Eye,
  AlertTriangle,
  FileImage,
  File,
  Loader2,
  Play,
  FileAudio,
  FileVideo,
  LayoutGrid,
  List,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Paperclip,
  Pencil,
  ShieldCheck
} from "lucide-react";
import { FilterChip } from "@/components/FilterChip";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { renderSourceNote } from "@/lib/renderSourceNote";
import { type Evidence, type EvidenceAttachment, EVIDENCE_DOCUMENT_TYPE_OPTIONS, EVIDENCE_IMPORTANCE_OPTIONS, type EvidenceDocumentType, type EvidenceImportance } from "@/lib/database";
import { 
  addEvidence, 
  updateEvidence, 
  deleteEvidence, 
  getEvidenceAttachments,
  addEvidenceAttachment,
  deleteEvidenceAttachment,
  getAllEvidence,
  countEvidenceAttachmentsByEvidenceId,
} from "@/lib/dataFacade";
import { uploadFile, downloadFile, deleteFile, getFileBlob, isPreviewableType, getPreviewType } from "@/lib/attachments";
import { useDropzone } from "react-dropzone";
import { searchPendingClass } from "@/lib/search-pending-class";
import { getAllSavedPsbts } from "@/lib/data/saved-psbts-crud";
import {
  setPendingNotarization,
  hashBlobSha256Hex,
  findNotarizationsForAttachment,
  type NotarizationRecord,
} from "@/lib/evidence-notarization";

const evidenceFormSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title too long"),
  documentType: z.string().min(1, "Document type is required"),
  originalDate: z.string().optional(),
  notes: z.string().optional(),
  tags: z.string().optional(),
  partiesInvolved: z.string().optional(),
  source: z.string().optional(),
  importance: z.string().optional(),
});

type EvidenceFormValues = z.infer<typeof evidenceFormSchema>;

export default function EvidencePage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, isSearchPending] = useDebouncedValue(searchTerm, PAGE_DEBOUNCE.Evidence);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterImportance, setFilterImportance] = useState<string>("all");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isDetailDialogOpen, setIsDetailDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence | null>(null);
  const [selectedAttachments, setSelectedAttachments] = useState<EvidenceAttachment[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isPreviewDialogOpen, setIsPreviewDialogOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<EvidenceAttachment | null>(null);
  const [previewEvidence, setPreviewEvidence] = useState<Evidence | null>(null);
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [previewTextContent, setPreviewTextContent] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortColumn, setSortColumn] = useState<'date' | 'title' | 'type' | 'importance' | 'source' | 'parties'>('date');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');
  const [attachmentCounts, setAttachmentCounts] = useState<Map<number, number>>(new Map());
  const [notarizingId, setNotarizingId] = useState<number | null>(null);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);

  // Saved PSBTs drive the notarized state of each attachment (the OP_RETURN
  // data output records the payload + evidence reference).
  const savedPsbts = useLiveQuery(() => getAllSavedPsbts(), []);
  const notarizationsByAttachment = new Map<number, NotarizationRecord[]>();
  if (savedPsbts) {
    for (const att of selectedAttachments) {
      const matches = findNotarizationsForAttachment(savedPsbts, att, selectedEvidence?.id);
      if (matches.length > 0 && att.id !== undefined) {
        notarizationsByAttachment.set(att.id, matches);
      }
    }
  }

  const rawEvidence = useLiveQuery(() => getAllEvidence(), []);
  const [loadedEvidence, setLoadedEvidence] = useState<Evidence[]>([]);

  useLiveQuery(async () => {
    if (rawEvidence && rawEvidence.length > 0) {
      setLoadedEvidence(rawEvidence);
    } else {
      setLoadedEvidence([]);
    }
  }, [rawEvidence]);

  const filteredEvidence = loadedEvidence.filter((evidence) => {
    const matchesSearch = 
      debouncedSearchTerm === "" ||
      evidence.title.toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
      evidence.notes?.toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
      evidence.partiesInvolved?.some(p => p.toLowerCase().includes(debouncedSearchTerm.toLowerCase())) ||
      evidence.tags?.some(t => t.toLowerCase().includes(debouncedSearchTerm.toLowerCase())) ||
      evidence.source?.toLowerCase().includes(debouncedSearchTerm.toLowerCase());
    
    const matchesType = filterType === "all" || evidence.documentType === filterType;
    const matchesImportance = filterImportance === "all" || evidence.importance === filterImportance;
    
    return matchesSearch && matchesType && matchesImportance;
  });

  const hasActiveFilters = debouncedSearchTerm.trim() !== "" || filterType !== "all" || filterImportance !== "all";

  const clearAllFilters = () => {
    setSearchTerm("");
    setFilterType("all");
    setFilterImportance("all");
  };

  const sortedEvidence = [...filteredEvidence].sort((a, b) => {
    let comparison = 0;
    
    switch (sortColumn) {
      case 'date':
        const dateA = a.originalDate || a.createdAt / 1000;
        const dateB = b.originalDate || b.createdAt / 1000;
        comparison = dateA - dateB;
        break;
      case 'title':
        comparison = a.title.localeCompare(b.title);
        break;
      case 'type':
        comparison = a.documentType.localeCompare(b.documentType);
        break;
      case 'importance':
        const impOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        const impA = impOrder[a.importance as keyof typeof impOrder] || 0;
        const impB = impOrder[b.importance as keyof typeof impOrder] || 0;
        comparison = impA - impB;
        break;
      case 'source':
        comparison = (a.source || '').localeCompare(b.source || '');
        break;
      case 'parties':
        const partiesA = a.partiesInvolved?.join(', ') || '';
        const partiesB = b.partiesInvolved?.join(', ') || '';
        comparison = partiesA.localeCompare(partiesB);
        break;
    }
    
    return sortDirection === 'desc' ? -comparison : comparison;
  });

  // Load attachment counts for list view
  useLiveQuery(async () => {
    if (viewMode === 'list' && loadedEvidence.length > 0) {
      const counts = new Map<number, number>();
      for (const ev of loadedEvidence) {
        if (ev.id) {
          const count = await countEvidenceAttachmentsByEvidenceId(ev.id);
          counts.set(ev.id, count);
        }
      }
      setAttachmentCounts(counts);
    }
  }, [viewMode, loadedEvidence]);

  const form = useForm<EvidenceFormValues>({
    resolver: zodResolver(evidenceFormSchema),
    defaultValues: {
      title: "",
      documentType: "",
      originalDate: "",
      notes: "",
      tags: "",
      partiesInvolved: "",
      source: "",
      importance: "",
    },
  });

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setPendingFiles(prev => [...prev, ...acceptedFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
  });

  const removePendingFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const openAddDialog = () => {
    form.reset({
      title: "",
      documentType: "",
      originalDate: "",
      notes: "",
      tags: "",
      partiesInvolved: "",
      source: "",
      importance: "",
    });
    setPendingFiles([]);
    setIsEditing(false);
    setSelectedEvidence(null);
    setIsAddDialogOpen(true);
  };

  const openEditDialog = async (evidence: Evidence) => {
    const dateStr = evidence.originalDate 
      ? format(new Date(evidence.originalDate * 1000), "yyyy-MM-dd")
      : "";
    
    form.reset({
      title: evidence.title,
      documentType: evidence.documentType,
      originalDate: dateStr,
      notes: evidence.notes || "",
      tags: evidence.tags?.join(", ") || "",
      partiesInvolved: evidence.partiesInvolved?.join(", ") || "",
      source: evidence.source || "",
      importance: evidence.importance || "",
    });
    
    setPendingFiles([]);
    setSelectedEvidence(evidence);
    setIsEditing(true);
    
    if (evidence.id) {
      const attachments = await getEvidenceAttachments(evidence.id);
      setSelectedAttachments(attachments);
    }
    
    setIsAddDialogOpen(true);
  };

  const openDetailDialog = async (evidence: Evidence) => {
    setSelectedEvidence(evidence);
    
    if (evidence.id) {
      const attachments = await getEvidenceAttachments(evidence.id);
      setSelectedAttachments(attachments);
    }
    
    setIsDetailDialogOpen(true);
  };

  const confirmDelete = (evidence: Evidence) => {
    setSelectedEvidence(evidence);
    setIsDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!selectedEvidence?.id) return;
    
    setIsLoading(true);
    try {
      for (const attachment of selectedAttachments) {
        if (attachment.objectStoragePath) {
          await deleteFile(attachment.objectStoragePath);
        }
      }
      
      await deleteEvidence(selectedEvidence.id);
      
      toast({
        title: "Evidence deleted",
        description: "The evidence entry has been permanently deleted.",
      });
      
      setIsDeleteDialogOpen(false);
      setIsDetailDialogOpen(false);
      setSelectedEvidence(null);
      setSelectedAttachments([]);
    } catch (error) {
      console.error("Failed to delete evidence:", error);
      toast({
        title: "Error",
        description: "Failed to delete evidence. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const onSubmit = async (values: EvidenceFormValues) => {
    setIsLoading(true);
    try {
      const tags = values.tags 
        ? values.tags.split(",").map(t => t.trim()).filter(Boolean)
        : [];
      
      const partiesInvolved = values.partiesInvolved
        ? values.partiesInvolved.split(",").map(p => p.trim()).filter(Boolean)
        : [];
      
      const originalDate = values.originalDate
        ? Math.floor(new Date(values.originalDate).getTime() / 1000)
        : undefined;

      const evidenceData = {
        title: values.title,
        documentType: values.documentType as EvidenceDocumentType,
        originalDate,
        notes: values.notes || undefined,
        tags,
        partiesInvolved: partiesInvolved.length > 0 ? partiesInvolved : undefined,
        source: values.source || undefined,
        importance: (values.importance || undefined) as EvidenceImportance | undefined,
      };

      let evidenceId: number;

      if (isEditing && selectedEvidence?.id) {
        await updateEvidence(selectedEvidence.id, evidenceData);
        evidenceId = selectedEvidence.id;
        
        toast({
          title: "Evidence updated",
          description: "Your changes have been saved.",
        });
      } else {
        evidenceId = await addEvidence(evidenceData);
        
        toast({
          title: "Evidence added",
          description: "The new evidence entry has been created.",
        });
      }

      if (pendingFiles.length > 0) {
        for (const file of pendingFiles) {
          const storagePath = await uploadFile(file);
          
          await addEvidenceAttachment({
            evidenceId,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            objectStoragePath: storagePath,
          });
        }
      }

      setIsAddDialogOpen(false);
      form.reset();
      setPendingFiles([]);
      setSelectedEvidence(null);
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to save evidence:", error);
      toast({
        title: "Error",
        description: "Failed to save evidence. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadAttachment = async (attachment: EvidenceAttachment) => {
    try {
      await downloadFile(attachment.objectStoragePath, attachment.filename);
    } catch (error) {
      console.error("Failed to download file:", error);
      toast({
        title: "Error",
        description: "Failed to download the file.",
        variant: "destructive",
      });
    }
  };

  // Notarize on-chain: hash the stored bytes with SHA-256 and hand the digest
  // to the PSBT builder (on the UTXOs page) as an OP_RETURN data output. The
  // transaction is signed and broadcast externally — the app never signs.
  const handleNotarizeAttachment = async (attachment: EvidenceAttachment) => {
    if (attachment.id === undefined) return;
    setNotarizingId(attachment.id);
    try {
      const blob = await getFileBlob(attachment.objectStoragePath, attachment.mimeType);
      const payloadHex = await hashBlobSha256Hex(blob);
      setPendingNotarization({
        payloadHex,
        evidenceId: selectedEvidence?.id,
        evidenceAttachmentId: attachment.id,
        evidenceTitle: selectedEvidence?.title,
        evidenceFilename: attachment.filename,
      });
      toast({
        title: "Digest computed",
        description: "Select the UTXOs to fund the notarization transaction, then Build PSBT.",
      });
      navigate("/utxos");
    } catch (error) {
      console.error("Failed to notarize attachment:", error);
      toast({
        title: "Could not notarize the file",
        description: error instanceof Error ? error.message : "Failed to read the file bytes.",
        variant: "destructive",
      });
    } finally {
      setNotarizingId(null);
    }
  };

  // Verify: re-hash the current bytes and compare against the digest recorded
  // in the saved PSBT's OP_RETURN payload.
  const handleVerifyNotarization = async (attachment: EvidenceAttachment) => {
    if (attachment.id === undefined) return;
    const recorded = notarizationsByAttachment.get(attachment.id) ?? [];
    if (recorded.length === 0) return;
    setVerifyingId(attachment.id);
    try {
      const blob = await getFileBlob(attachment.objectStoragePath, attachment.mimeType);
      const payloadHex = await hashBlobSha256Hex(blob);
      const match = recorded.find((r) => r.payloadHex === payloadHex);
      if (match) {
        toast({
          title: "Notarization verified",
          description: `The current file bytes still match the digest embedded in "${match.savedPsbtName}".`,
        });
      } else {
        toast({
          title: "Notarization mismatch",
          description:
            "The current file bytes do NOT match the notarized digest — the file has changed since it was notarized.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Failed to verify notarization:", error);
      toast({
        title: "Could not verify the notarization",
        description: error instanceof Error ? error.message : "Failed to read the file bytes.",
        variant: "destructive",
      });
    } finally {
      setVerifyingId(null);
    }
  };

  const handleDeleteAttachment = async (attachment: EvidenceAttachment) => {
    if (!attachment.id) return;
    
    try {
      await deleteFile(attachment.objectStoragePath);
      await deleteEvidenceAttachment(attachment.id);
      
      setSelectedAttachments(prev => prev.filter(a => a.id !== attachment.id));
      
      toast({
        title: "Attachment deleted",
        description: "The file has been removed.",
      });
    } catch (error) {
      console.error("Failed to delete attachment:", error);
      toast({
        title: "Error",
        description: "Failed to delete the attachment.",
        variant: "destructive",
      });
    }
  };

  const handlePreviewAttachment = async (attachment: EvidenceAttachment) => {
    const previewType = getPreviewType(attachment.mimeType);
    
    // Guard against unsupported types
    if (previewType === 'unsupported') {
      toast({
        title: "Preview not available",
        description: "This file type cannot be previewed. Please download it instead.",
        variant: "destructive",
      });
      return;
    }
    
    // Revoke any existing blob URL before creating a new one to prevent memory leaks
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      setPreviewBlobUrl(null);
    }
    setPreviewTextContent(null);
    
    setPreviewAttachment(attachment);
    setIsPreviewDialogOpen(true);
    setIsPreviewLoading(true);
    
    try {
      const blob = await getFileBlob(
        attachment.objectStoragePath, 
        attachment.mimeType
      );
      
      if (previewType === 'text') {
        const text = await blob.text();
        setPreviewTextContent(text);
      } else {
        const url = URL.createObjectURL(blob);
        setPreviewBlobUrl(url);
      }
    } catch (error) {
      console.error("Failed to load preview:", error);
      toast({
        title: "Error",
        description: "Failed to load file preview.",
        variant: "destructive",
      });
      setIsPreviewDialogOpen(false);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const closePreviewDialog = () => {
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
    }
    setPreviewBlobUrl(null);
    setPreviewTextContent(null);
    setPreviewAttachment(null);
    setPreviewEvidence(null);
    setIsPreviewDialogOpen(false);
  };

  const getDocumentTypeLabel = (type: string) => {
    return EVIDENCE_DOCUMENT_TYPE_OPTIONS.find(o => o.value === type)?.label || type;
  };

  const getImportanceColor = (importance?: string) => {
    switch (importance) {
      case "critical": return "bg-red-500/20 text-red-700 dark:text-red-400";
      case "high": return "bg-orange-500/20 text-orange-700 dark:text-orange-400";
      case "medium": return "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400";
      case "low": return "bg-green-500/20 text-green-700 dark:text-green-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith("image/")) return FileImage;
    return File;
  };

  // Handle quick view list item click - opens preview with full metadata
  const handleQuickViewClick = async (evidence: Evidence) => {
    if (!evidence.id) {
      openDetailDialog(evidence);
      return;
    }
    
    try {
      const attachments = await getEvidenceAttachments(evidence.id);
      const previewable = attachments.find(att => isPreviewableType(att.mimeType));
      
      // Always set the preview evidence for metadata display
      setPreviewEvidence(evidence);
      
      if (previewable) {
        handlePreviewAttachment(previewable);
      } else {
        // Open preview dialog even without previewable attachment to show metadata
        setPreviewAttachment(null);
        setIsPreviewDialogOpen(true);
      }
    } catch (error) {
      console.error("Failed to load attachments:", error);
      openDetailDialog(evidence);
    }
  };
  
  // Handle edit from preview dialog
  const handleEditFromPreview = () => {
    if (previewEvidence) {
      closePreviewDialog();
      openDetailDialog(previewEvidence);
      setIsEditing(true);
    }
  };

  const handleColumnSort = (column: 'date' | 'title' | 'type' | 'importance' | 'source' | 'parties') => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'desc' ? 'asc' : 'desc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const SortIcon = ({ column }: { column: typeof sortColumn }) => {
    if (sortColumn !== column) return null;
    return sortDirection === 'desc' 
      ? <ArrowDown className="h-3 w-3" />
      : <ArrowUp className="h-3 w-3" />;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">Evidence</h1>
          <p className="text-sm text-muted-foreground">
            Store and organize files which do not relate to specific addresses or TXIDs. Documents, emails, screenshots, receipts, etc.
          </p>
        </div>
        <Button onClick={openAddDialog} data-testid="button-add-evidence">
          <Plus className="h-4 w-4 mr-2" />
          Add Evidence
        </Button>
      </div>

      <div className="flex items-center gap-4 p-4 border-b flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          {isSearchPending ? (
            <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" data-testid="icon-search-pending" />
          ) : (
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          )}
          <Input
            placeholder="Search by title, notes, parties, tags, or source..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search"
          />
        </div>
        
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-[180px]" data-testid="select-filter-type">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue placeholder="Document Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {EVIDENCE_DOCUMENT_TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterImportance} onValueChange={setFilterImportance}>
          <SelectTrigger className="w-[150px]" data-testid="select-filter-importance">
            <SelectValue placeholder="Importance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Importance</SelectItem>
            {EVIDENCE_IMPORTANCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAllFilters}
            className="h-9 text-xs"
            data-testid="button-clear-all-filters"
          >
            <X className="h-3 w-3 mr-1" />
            Clear All Filters
          </Button>
        )}

        <div className="flex items-center gap-1 border-l pl-4">
          <Button
            size="icon"
            variant={viewMode === 'grid' ? 'default' : 'outline'}
            onClick={() => setViewMode('grid')}
            title="Grid view"
            data-testid="button-view-grid"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant={viewMode === 'list' ? 'default' : 'outline'}
            onClick={() => setViewMode('list')}
            title="List view"
            data-testid="button-view-list"
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b">
          {searchTerm.trim() && (
            <FilterChip
              label={`Search: "${searchTerm.trim()}"`}
              onRemove={() => setSearchTerm("")}
              testId="chip-filter-search"
            />
          )}
          {filterType !== "all" && (
            <FilterChip
              label={`Type: ${EVIDENCE_DOCUMENT_TYPE_OPTIONS.find(o => o.value === filterType)?.label || filterType}`}
              onRemove={() => setFilterType("all")}
              testId="chip-filter-type"
            />
          )}
          {filterImportance !== "all" && (
            <FilterChip
              label={`Importance: ${EVIDENCE_IMPORTANCE_OPTIONS.find(o => o.value === filterImportance)?.label || filterImportance}`}
              onRemove={() => setFilterImportance("all")}
              testId="chip-filter-importance"
            />
          )}
        </div>
      )}

      <ScrollArea className={`flex-1 ${searchPendingClass(isSearchPending, 'Evidence')}`}>
        <div className="p-4">
          {sortedEvidence.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <FileText className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No evidence found</h3>
                <p className="text-sm text-muted-foreground text-center max-w-md mb-4">
                  {loadedEvidence.length === 0 
                    ? "Add your first piece of evidence to keep track of important documents, emails, and receipts."
                    : "No evidence matches your current filters."}
                </p>
                {loadedEvidence.length === 0 && (
                  <Button onClick={openAddDialog} variant="outline">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Evidence
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : viewMode === 'grid' ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {sortedEvidence.map((evidence) => (
                <Card 
                  key={evidence.id} 
                  className="hover-elevate cursor-pointer"
                  onClick={() => handleQuickViewClick(evidence)}
                  data-testid={`card-evidence-${evidence.id}`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-base truncate">
                          {evidence.title}
                        </CardTitle>
                        <CardDescription className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" className="text-xs">
                            {getDocumentTypeLabel(evidence.documentType)}
                          </Badge>
                          {evidence.importance && (
                            <Badge className={`text-xs ${getImportanceColor(evidence.importance)}`}>
                              {evidence.importance}
                            </Badge>
                          )}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {evidence.notes && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                        {renderSourceNote(evidence.notes)}
                      </p>
                    )}
                    
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {evidence.originalDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {format(new Date(evidence.originalDate * 1000), "MMM d, yyyy")}
                        </span>
                      )}
                      {evidence.partiesInvolved && evidence.partiesInvolved.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {evidence.partiesInvolved.length} {evidence.partiesInvolved.length === 1 ? "party" : "parties"}
                        </span>
                      )}
                    </div>
                    
                    {evidence.tags && evidence.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {evidence.tags.slice(0, 3).map((tag, i) => (
                          <Badge key={i} variant="outline" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                        {evidence.tags.length > 3 && (
                          <Badge variant="outline" className="text-xs">
                            +{evidence.tags.length - 3}
                          </Badge>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            /* Compact Quick View List */
            <div className="space-y-1">
              {/* List Header */}
              <div className="flex items-center gap-4 px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                <div 
                  className="w-24 flex items-center gap-1 cursor-pointer hover:text-foreground"
                  onClick={() => handleColumnSort('date')}
                  data-testid="header-sort-date"
                >
                  Date
                  <SortIcon column="date" />
                </div>
                <div 
                  className="flex-1 min-w-0 flex items-center gap-1 cursor-pointer hover:text-foreground"
                  onClick={() => handleColumnSort('title')}
                  data-testid="header-sort-title"
                >
                  Title
                  <SortIcon column="title" />
                </div>
                <div 
                  className="w-24 flex items-center gap-1 cursor-pointer hover:text-foreground"
                  onClick={() => handleColumnSort('type')}
                  data-testid="header-sort-type"
                >
                  Type
                  <SortIcon column="type" />
                </div>
                <div 
                  className="w-20 flex items-center gap-1 cursor-pointer hover:text-foreground"
                  onClick={() => handleColumnSort('importance')}
                  data-testid="header-sort-importance"
                >
                  Importance
                  <SortIcon column="importance" />
                </div>
                <div className="w-16 text-center">Files</div>
                <div 
                  className="w-28 flex items-center gap-1 cursor-pointer hover:text-foreground"
                  onClick={() => handleColumnSort('source')}
                  data-testid="header-sort-source"
                >
                  Source
                  <SortIcon column="source" />
                </div>
                <div 
                  className="w-32 flex items-center gap-1 cursor-pointer hover:text-foreground"
                  onClick={() => handleColumnSort('parties')}
                  data-testid="header-sort-parties"
                >
                  Parties
                  <SortIcon column="parties" />
                </div>
              </div>
              {sortedEvidence.map((evidence) => {
                const effectiveDate = evidence.originalDate 
                  ? new Date(evidence.originalDate * 1000)
                  : new Date(evidence.createdAt);
                const attachCount = evidence.id ? (attachmentCounts.get(evidence.id) || 0) : 0;
                
                return (
                  <div
                    key={evidence.id}
                    className="flex items-center gap-4 px-3 py-2 rounded-md hover-elevate cursor-pointer border-b border-transparent hover:border-border"
                    onClick={() => handleQuickViewClick(evidence)}
                    data-testid={`row-evidence-${evidence.id}`}
                  >
                    {/* Date */}
                    <div className="w-24 text-xs text-muted-foreground shrink-0">
                      {format(effectiveDate, "MMM d, yyyy")}
                    </div>
                    
                    {/* Title + Tags */}
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {evidence.title}
                      </span>
                      {evidence.tags && evidence.tags.length > 0 && (
                        <div className="flex gap-1 shrink-0">
                          {evidence.tags.slice(0, 2).map((tag, i) => (
                            <Badge key={i} variant="outline" className="text-xs px-1 py-0">
                              {tag}
                            </Badge>
                          ))}
                          {evidence.tags.length > 2 && (
                            <span className="text-xs text-muted-foreground">+{evidence.tags.length - 2}</span>
                          )}
                        </div>
                      )}
                    </div>
                    
                    {/* Type */}
                    <div className="w-24 shrink-0">
                      <Badge variant="secondary" className="text-xs">
                        {getDocumentTypeLabel(evidence.documentType)}
                      </Badge>
                    </div>
                    
                    {/* Importance */}
                    <div className="w-20 shrink-0">
                      {evidence.importance && (
                        <Badge className={`text-xs ${getImportanceColor(evidence.importance)}`}>
                          {evidence.importance}
                        </Badge>
                      )}
                    </div>
                    
                    {/* Attachment Count */}
                    <div className="w-16 text-center shrink-0">
                      {attachCount > 0 && (
                        <span className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                          <Paperclip className="h-3 w-3" />
                          {attachCount}
                        </span>
                      )}
                    </div>
                    
                    {/* Source */}
                    <div className="w-28 shrink-0 text-xs text-muted-foreground truncate">
                      {evidence.source || ''}
                    </div>
                    
                    {/* Parties */}
                    <div className="w-32 shrink-0 text-xs text-muted-foreground truncate">
                      {evidence.partiesInvolved && evidence.partiesInvolved.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3 shrink-0" />
                          <span className="truncate">{evidence.partiesInvolved.join(", ")}</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ScrollArea>

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Evidence" : "Add Evidence"}</DialogTitle>
            <DialogDescription>
              {isEditing 
                ? "Update the details of this evidence entry."
                : "Add a new document, email, screenshot, or receipt to your evidence collection."}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title *</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="e.g., Bitcoin purchase confirmation email" 
                        {...field} 
                        data-testid="input-title"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="documentType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Document Type *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-document-type">
                            <SelectValue placeholder="Select type..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {EVIDENCE_DOCUMENT_TYPE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="originalDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Original Date</FormLabel>
                      <FormControl>
                        <Input 
                          type="date" 
                          {...field} 
                          data-testid="input-original-date"
                        />
                      </FormControl>
                      <FormDescription>When was this document created?</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="importance"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Importance</FormLabel>
                      <Select 
                        onValueChange={(val) => field.onChange(val === "__none__" ? "" : val)} 
                        value={field.value || "__none__"}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-importance">
                            <SelectValue placeholder="Select importance..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {EVIDENCE_IMPORTANCE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="source"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Source</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="e.g., Gmail, Coinbase, Bank of America" 
                          {...field} 
                          data-testid="input-source"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea 
                        placeholder="Add any relevant details or context..."
                        className="min-h-[100px]"
                        {...field} 
                        data-testid="textarea-notes"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="partiesInvolved"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Parties Involved</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="e.g., John Smith, Coinbase, XYZ Corp (comma-separated)" 
                        {...field} 
                        data-testid="input-parties"
                      />
                    </FormControl>
                    <FormDescription>People, companies, or platforms mentioned</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tags</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="e.g., purchase, 2017, important (comma-separated)" 
                        {...field} 
                        data-testid="input-tags"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-2">
                <FormLabel>Attachments</FormLabel>
                
                {isEditing && selectedAttachments.length > 0 && (
                  <div className="space-y-2 mb-3">
                    <p className="text-sm text-muted-foreground">Existing files:</p>
                    {selectedAttachments.map((att) => {
                      const FileIcon = getFileIcon(att.mimeType);
                      return (
                        <div 
                          key={att.id} 
                          className="flex items-center justify-between p-2 bg-muted rounded-md"
                        >
                          <div className="flex items-center gap-2">
                            <FileIcon className="h-4 w-4" />
                            <span className="text-sm">{att.filename}</span>
                            <span className="text-xs text-muted-foreground">
                              ({(att.size / 1024).toFixed(1)} KB)
                            </span>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => handleDeleteAttachment(att)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div
                  {...getRootProps()}
                  className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                    isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"
                  }`}
                  data-testid="dropzone-files"
                >
                  <input {...getInputProps()} />
                  <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {isDragActive
                      ? "Drop files here..."
                      : "Drag & drop files here, or click to select"}
                  </p>
                </div>

                {pendingFiles.length > 0 && (
                  <div className="space-y-2 mt-3">
                    <p className="text-sm text-muted-foreground">Files to upload:</p>
                    {pendingFiles.map((file, index) => (
                      <div 
                        key={index} 
                        className="flex items-center justify-between p-2 bg-muted rounded-md"
                      >
                        <div className="flex items-center gap-2">
                          <File className="h-4 w-4" />
                          <span className="text-sm">{file.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ({(file.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removePendingFile(index)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => setIsAddDialogOpen(false)}
                  disabled={isLoading}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isLoading} data-testid="button-submit">
                  {isLoading ? "Saving..." : isEditing ? "Save Changes" : "Add Evidence"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={isDetailDialogOpen} onOpenChange={setIsDetailDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selectedEvidence && (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <DialogTitle className="text-xl">{selectedEvidence.title}</DialogTitle>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary">
                        {getDocumentTypeLabel(selectedEvidence.documentType)}
                      </Badge>
                      {selectedEvidence.importance && (
                        <Badge className={getImportanceColor(selectedEvidence.importance)}>
                          {selectedEvidence.importance}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setIsDetailDialogOpen(false);
                        openEditDialog(selectedEvidence);
                      }}
                      title="Edit"
                      data-testid="button-edit-evidence"
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => confirmDelete(selectedEvidence)}
                      title="Delete"
                      data-testid="button-delete-evidence"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </DialogHeader>

              <div className="space-y-4">
                {selectedEvidence.originalDate && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Original Date</h4>
                    <p className="flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      {format(new Date(selectedEvidence.originalDate * 1000), "MMMM d, yyyy")}
                    </p>
                  </div>
                )}

                {selectedEvidence.source && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Source</h4>
                    <p>{selectedEvidence.source}</p>
                  </div>
                )}

                {selectedEvidence.notes && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Notes</h4>
                    <p className="whitespace-pre-wrap">{renderSourceNote(selectedEvidence.notes)}</p>
                  </div>
                )}

                {selectedEvidence.partiesInvolved && selectedEvidence.partiesInvolved.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Parties Involved</h4>
                    <div className="flex flex-wrap gap-2">
                      {selectedEvidence.partiesInvolved.map((party, i) => (
                        <Badge 
                          key={i} 
                          variant="secondary"
                          className="cursor-pointer hover-elevate"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSearchTerm(party);
                            setIsDetailDialogOpen(false);
                          }}
                          title={`Click to filter by "${party}"`}
                          data-testid={`badge-party-${i}`}
                        >
                          <Users className="h-3 w-3 mr-1" />
                          {party}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedEvidence.tags && selectedEvidence.tags.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">Tags</h4>
                    <div className="flex flex-wrap gap-2">
                      {selectedEvidence.tags.map((tag, i) => (
                        <Badge 
                          key={i} 
                          variant="outline"
                          className="cursor-pointer hover-elevate"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSearchTerm(tag);
                            setIsDetailDialogOpen(false);
                          }}
                          title={`Click to filter by "${tag}"`}
                          data-testid={`badge-tag-${i}`}
                        >
                          <Tag className="h-3 w-3 mr-1" />
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedAttachments.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-2">Attachments</h4>
                    <div className="space-y-2">
                      {selectedAttachments.map((att) => {
                        const FileIcon = getFileIcon(att.mimeType);
                        const canPreview = isPreviewableType(att.mimeType) && getPreviewType(att.mimeType) !== 'unsupported';
                        return (
                          <div 
                            key={att.id} 
                            className="flex items-center justify-between p-3 bg-muted rounded-md"
                          >
                            <div className="flex items-center gap-3">
                              <FileIcon className="h-5 w-5" />
                              <div>
                                <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                                  {att.filename}
                                  {att.id !== undefined && notarizationsByAttachment.has(att.id) && (
                                    <Badge variant="outline" className="text-xs" data-testid={`badge-notarized-${att.id}`}>
                                      <ShieldCheck className="h-3 w-3 mr-1" />
                                      Notarized
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {(att.size / 1024).toFixed(1)} KB
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {att.id !== undefined && notarizationsByAttachment.has(att.id) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={verifyingId === att.id}
                                  onClick={() => handleVerifyNotarization(att)}
                                  title="Re-hash the current file bytes and compare to the notarized digest"
                                  data-testid={`button-verify-notarization-${att.id}`}
                                >
                                  {verifyingId === att.id ? (
                                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                  ) : (
                                    <ShieldCheck className="h-4 w-4 mr-1" />
                                  )}
                                  Verify
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={notarizingId === att.id}
                                  onClick={() => handleNotarizeAttachment(att)}
                                  title="Hash this file and embed the digest in an OP_RETURN output"
                                  data-testid={`button-notarize-${att.id}`}
                                >
                                  {notarizingId === att.id ? (
                                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                  ) : (
                                    <ShieldCheck className="h-4 w-4 mr-1" />
                                  )}
                                  Notarize on-chain
                                </Button>
                              )}
                              {canPreview && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handlePreviewAttachment(att)}
                                  data-testid={`button-preview-${att.id}`}
                                >
                                  <Eye className="h-4 w-4 mr-1" />
                                  Preview
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleDownloadAttachment(att)}
                                data-testid={`button-download-${att.id}`}
                              >
                                <Download className="h-4 w-4 mr-1" />
                                Download
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="pt-4 border-t text-xs text-muted-foreground">
                  <p>Created: {format(new Date(selectedEvidence.createdAt), "MMM d, yyyy 'at' h:mm a")}</p>
                  <p>Updated: {format(new Date(selectedEvidence.updatedAt), "MMM d, yyyy 'at' h:mm a")}</p>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Evidence
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedEvidence?.title}"? This will also delete 
              all attached files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDelete} 
              disabled={isLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isLoading ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={isPreviewDialogOpen} onOpenChange={(open) => !open && closePreviewDialog()}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {previewEvidence?.title || previewAttachment?.filename || "Preview"}
            </DialogTitle>
            {previewEvidence && (
              // Not a DialogDescription: that renders a <p>, and Badges (divs)
              // inside it trip validateDOMNesting in the browser.
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <Badge variant="secondary">{getDocumentTypeLabel(previewEvidence.documentType)}</Badge>
                {previewEvidence.importance && (
                  <Badge className={getImportanceColor(previewEvidence.importance)}>
                    {previewEvidence.importance}
                  </Badge>
                )}
              </div>
            )}
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-auto flex gap-4">
            {/* File Preview Section */}
            {previewAttachment && (
              <div className="flex-1 min-w-0 bg-muted/30 rounded-md overflow-auto">
                {isPreviewLoading ? (
                  <div className="flex items-center justify-center h-64">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <>
                    {getPreviewType(previewAttachment.mimeType) === 'image' && previewBlobUrl && (
                      <div className="flex items-center justify-center p-4">
                        <img 
                          src={previewBlobUrl} 
                          alt={previewAttachment.filename}
                          className="max-w-full max-h-[50vh] object-contain rounded"
                          data-testid="preview-image"
                        />
                      </div>
                    )}
                    
                    {getPreviewType(previewAttachment.mimeType) === 'text' && previewTextContent !== null && (
                      <ScrollArea className="h-[50vh] p-4">
                        <pre className="text-sm whitespace-pre-wrap font-mono" data-testid="preview-text">
                          {previewTextContent}
                        </pre>
                      </ScrollArea>
                    )}
                    
                    {getPreviewType(previewAttachment.mimeType) === 'audio' && previewBlobUrl && (
                      <div className="flex items-center justify-center p-8">
                        <audio 
                          controls 
                          src={previewBlobUrl}
                          className="w-full max-w-md"
                          data-testid="preview-audio"
                        />
                      </div>
                    )}
                    
                    {getPreviewType(previewAttachment.mimeType) === 'video' && previewBlobUrl && (
                      <div className="flex items-center justify-center p-4">
                        <video 
                          controls 
                          src={previewBlobUrl}
                          className="max-w-full max-h-[50vh] rounded"
                          data-testid="preview-video"
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            
            {/* Metadata Panel */}
            {previewEvidence && (
              <div className={`${previewAttachment ? 'w-80' : 'flex-1'} shrink-0 space-y-4 overflow-auto`}>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {/* Date */}
                    {previewEvidence.originalDate && (
                      <div className="flex items-start gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div>
                          <div className="text-muted-foreground text-xs">Date</div>
                          <div>{format(new Date(previewEvidence.originalDate * 1000), "MMMM d, yyyy")}</div>
                        </div>
                      </div>
                    )}
                    
                    {/* Source */}
                    {previewEvidence.source && (
                      <div className="flex items-start gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div>
                          <div className="text-muted-foreground text-xs">Source</div>
                          <div>{previewEvidence.source}</div>
                        </div>
                      </div>
                    )}
                    
                    {/* Parties Involved */}
                    {previewEvidence.partiesInvolved && previewEvidence.partiesInvolved.length > 0 && (
                      <div className="flex items-start gap-2">
                        <Users className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div>
                          <div className="text-muted-foreground text-xs">Parties Involved</div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {previewEvidence.partiesInvolved.map((party, i) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                {party}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Tags */}
                    {previewEvidence.tags && previewEvidence.tags.length > 0 && (
                      <div className="flex items-start gap-2">
                        <Tag className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div>
                          <div className="text-muted-foreground text-xs">Tags</div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {previewEvidence.tags.map((tag, i) => (
                              <Badge key={i} variant="secondary" className="text-xs">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Notes */}
                    {previewEvidence.notes && (
                      <div className="pt-2 border-t">
                        <div className="text-muted-foreground text-xs mb-1">Notes</div>
                        <p className="text-sm whitespace-pre-wrap">{renderSourceNote(previewEvidence.notes)}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
                
                {/* File info if attachment present */}
                {previewAttachment && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Attachment</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex items-center gap-2">
                        {(() => {
                          const FileIcon = getFileIcon(previewAttachment.mimeType);
                          return <FileIcon className="h-4 w-4 text-muted-foreground" />;
                        })()}
                        <span className="truncate">{previewAttachment.filename}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {(previewAttachment.size / 1024).toFixed(1)} KB
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
            
            {/* No content fallback */}
            {!previewAttachment && !previewEvidence && (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                No preview available
              </div>
            )}
          </div>

          <DialogFooter className="flex-shrink-0 gap-2">
            {previewAttachment && (
              <Button
                variant="outline"
                onClick={() => handleDownloadAttachment(previewAttachment)}
                data-testid="button-preview-download"
              >
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleEditFromPreview}
              data-testid="button-preview-edit"
            >
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
            <Button onClick={closePreviewDialog} data-testid="button-preview-close">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
