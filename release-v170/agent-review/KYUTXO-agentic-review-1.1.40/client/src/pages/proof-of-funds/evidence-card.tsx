import { useState, useRef, useCallback } from "react";
import {
  FileText,
  Loader2,
  Upload,
  Trash2,
  Image as ImageIcon,
  Paperclip,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { countPdfPages } from "@/lib/pdfMerge";
import {
  type EvidenceItem,
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_FILE_BYTES,
  EVIDENCE_MAX_TOTAL_BYTES,
  EVIDENCE_ACCEPT,
  EVIDENCE_IMAGE_MIMES,
  nextEvidenceId,
  hashBytesHex,
  imageBytesToDataUrl,
  formatEvidenceSize,
} from "./evidence-helpers";

interface EvidenceCardProps {
  evidenceItems: EvidenceItem[];
  setEvidenceItems: React.Dispatch<React.SetStateAction<EvidenceItem[]>>;
  evidenceImageCount: number;
  evidencePdfCount: number;
}

export function EvidenceCard({
  evidenceItems,
  setEvidenceItems,
  evidenceImageCount,
  evidencePdfCount,
}: EvidenceCardProps) {
  const { toast } = useToast();
  const [isAddingEvidence, setIsAddingEvidence] = useState(false);
  const evidenceInputRef = useRef<HTMLInputElement>(null);

  const handleEvidenceFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const incoming = Array.from(files);
      setIsAddingEvidence(true);
      try {
        const room = EVIDENCE_MAX_ITEMS - evidenceItems.length;
        if (room <= 0) {
          toast({
            title: "Evidence limit reached",
            description: `You can attach up to ${EVIDENCE_MAX_ITEMS} files.`,
            variant: "destructive",
          });
          return;
        }
        const toProcess = incoming.slice(0, room);
        const skippedForLimit = incoming.length - toProcess.length;
        const added: EvidenceItem[] = [];
        const errors: string[] = [];
        let runningTotal = evidenceItems.reduce((sum, it) => sum + it.size, 0);
        for (const file of toProcess) {
          const mime = file.type;
          const isImage = EVIDENCE_IMAGE_MIMES.includes(mime);
          const isPdf = mime === "application/pdf";
          if (!isImage && !isPdf) {
            errors.push(`${file.name}: unsupported file type`);
            continue;
          }
          if (file.size > EVIDENCE_MAX_FILE_BYTES) {
            errors.push(
              `${file.name}: larger than ${EVIDENCE_MAX_FILE_BYTES / (1024 * 1024)} MB`,
            );
            continue;
          }
          if (runningTotal + file.size > EVIDENCE_MAX_TOTAL_BYTES) {
            errors.push(
              `${file.name}: skipped — would exceed the ${EVIDENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB combined limit`,
            );
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const sha256 = await hashBytesHex(bytes);
          // Reserve this file's bytes against the combined cap so later files in
          // the same batch see an accurate running total.
          runningTotal += file.size;
          if (isPdf) {
            let pageCount: number;
            try {
              pageCount = await countPdfPages(bytes);
            } catch {
              // Not actually added — release its reserved bytes.
              runningTotal -= file.size;
              errors.push(
                `${file.name}: could not be read as a PDF (it may be corrupted or password-protected)`,
              );
              continue;
            }
            added.push({
              id: nextEvidenceId(),
              name: file.name,
              kind: "pdf",
              mime,
              bytes,
              caption: "",
              sha256,
              size: file.size,
              pageCount,
            });
          } else {
            added.push({
              id: nextEvidenceId(),
              name: file.name,
              kind: "image",
              mime,
              bytes,
              dataUrl: imageBytesToDataUrl(bytes, mime),
              caption: "",
              sha256,
              size: file.size,
            });
          }
        }
        if (added.length) setEvidenceItems((prev) => [...prev, ...added]);
        if (errors.length || skippedForLimit) {
          const parts = [...errors];
          if (skippedForLimit) {
            parts.push(
              `${skippedForLimit} file(s) skipped (limit of ${EVIDENCE_MAX_ITEMS})`,
            );
          }
          toast({
            title: added.length
              ? "Some files were not added"
              : "No files were added",
            description: parts.join("; "),
            variant: "destructive",
          });
        }
      } finally {
        setIsAddingEvidence(false);
        if (evidenceInputRef.current) evidenceInputRef.current.value = "";
      }
    },
    [evidenceItems, setEvidenceItems, toast],
  );

  const removeEvidenceItem = useCallback((id: string) => {
    setEvidenceItems((prev) => prev.filter((it) => it.id !== id));
  }, [setEvidenceItems]);

  const clearEvidence = useCallback(() => setEvidenceItems([]), [setEvidenceItems]);

  const updateEvidenceCaption = useCallback((id: string, caption: string) => {
    setEvidenceItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, caption } : it)),
    );
  }, [setEvidenceItems]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Step 12 — Supporting Evidence (optional)</CardTitle>
        <CardDescription>
          Attach images (screenshots or photos) and PDF documents to support your
          declaration. Images are embedded into the dossier, and PDFs are merged on
          as extra pages at the end. Files stay on your device and are only kept for
          this session — they are never uploaded or saved.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={evidenceInputRef}
          type="file"
          accept={EVIDENCE_ACCEPT}
          multiple
          className="hidden"
          data-testid="input-evidence-file"
          onChange={(e) => handleEvidenceFiles(e.target.files)}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="default"
            onClick={() => evidenceInputRef.current?.click()}
            disabled={
              isAddingEvidence || evidenceItems.length >= EVIDENCE_MAX_ITEMS
            }
            data-testid="button-add-evidence"
          >
            {isAddingEvidence ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Adding…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Add files
              </>
            )}
          </Button>
          {evidenceItems.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="default"
              onClick={clearEvidence}
              data-testid="button-clear-evidence"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear all
            </Button>
          )}
          <span
            className="text-xs text-muted-foreground"
            data-testid="text-evidence-count"
          >
            {evidenceItems.length === 0
              ? "No files attached"
              : `${evidenceItems.length} of ${EVIDENCE_MAX_ITEMS} file${
                  evidenceItems.length !== 1 ? "s" : ""
                } — ${evidenceImageCount} image${
                  evidenceImageCount !== 1 ? "s" : ""
                }, ${evidencePdfCount} PDF${
                  evidencePdfCount !== 1 ? "s" : ""
                }`}
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          Accepted: PNG, JPEG, WebP images and PDF documents. Up to{" "}
          {EVIDENCE_MAX_ITEMS} files, {EVIDENCE_MAX_FILE_BYTES / (1024 * 1024)} MB
          each, {EVIDENCE_MAX_TOTAL_BYTES / (1024 * 1024)} MB combined.
        </p>

        {evidenceItems.length > 0 && (
          <div className="space-y-2">
            {evidenceItems.map((it) => (
              <div
                key={it.id}
                data-testid={`row-evidence-${it.id}`}
                className="flex items-start gap-3 rounded-md border p-3"
              >
                <div className="shrink-0">
                  {it.kind === "image" && it.dataUrl ? (
                    <img
                      src={it.dataUrl}
                      alt={it.name}
                      className="h-16 w-16 rounded-md object-cover border"
                      data-testid={`img-evidence-${it.id}`}
                    />
                  ) : (
                    <div className="h-16 w-16 rounded-md border flex items-center justify-center bg-muted/40">
                      <FileText className="h-7 w-7 text-muted-foreground" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {it.kind === "image" ? (
                      <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span
                      className="text-sm font-medium truncate"
                      data-testid={`text-evidence-name-${it.id}`}
                    >
                      {it.name}
                    </span>
                    <Badge variant="secondary">
                      {it.kind === "pdf"
                        ? `PDF · ${it.pageCount ?? "?"} page${
                            it.pageCount === 1 ? "" : "s"
                          }`
                        : "Image"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatEvidenceSize(it.size)}
                    </span>
                  </div>
                  <Input
                    value={it.caption}
                    onChange={(e) =>
                      updateEvidenceCaption(it.id, e.target.value)
                    }
                    placeholder="Add a caption (optional)"
                    data-testid={`input-evidence-caption-${it.id}`}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeEvidenceItem(it.id)}
                  aria-label={`Remove ${it.name}`}
                  data-testid={`button-remove-evidence-${it.id}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
