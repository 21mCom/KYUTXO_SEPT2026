import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { 
  Shield,
  Plus,
  FileSignature,
  Clock,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Copy,
  Trash2,
  Download,
  Upload,
  Info,
  Loader2,
  Key,
  FileCheck,
  Lock,
  Calendar,
  Eye,
  EyeOff,
  Search
} from "lucide-react";
import { 
  db, 
  type OwnershipAttestation, 
  type ComplianceProof,
  type CustodySegment,
  type Record as DbRecord,
  type AttestationStatus,
  type ProofDisclosureLevel
} from "@/lib/database";
import { decryptRecords, isEncryptionReady } from "@/lib/encryptionFacade";
import { 
  generateAttestationMessage, 
  parseSignedMessage,
  createOwnershipAttestation,
  createComplianceProof,
  exportProofBundle,
  filterSegmentsByDateRange,
  filterSegmentsByAddresses,
  generateStandaloneVerifier
} from "@/lib/complianceProofs";
import { format, formatDistanceToNow, subYears } from "date-fns";

export default function ComplianceProofs() {
  const { toast } = useToast();
  
  const [attestations, setAttestations] = useState<OwnershipAttestation[]>([]);
  const [proofs, setProofs] = useState<ComplianceProof[]>([]);
  const [addresses, setAddresses] = useState<DbRecord[]>([]);
  const [custodySegments, setCustodySegments] = useState<CustodySegment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [newAttestationOpen, setNewAttestationOpen] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [attestationMessage, setAttestationMessage] = useState("");
  const [signatureInput, setSignatureInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const [newProofOpen, setNewProofOpen] = useState(false);
  const [proofName, setProofName] = useState("");
  const [proofDescription, setProofDescription] = useState("");
  const [selectedAddresses, setSelectedAddresses] = useState<Set<string>>(new Set());
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [disclosureLevel, setDisclosureLevel] = useState<ProofDisclosureLevel>("full");
  const [addressSearch, setAddressSearch] = useState("");
  const [isGeneratingProof, setIsGeneratingProof] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    try {
      const [attestationData, proofData, recordData, segmentData] = await Promise.all([
        db.ownershipAttestations.toArray(),
        db.complianceProofs.toArray(),
        db.records.where('type').equals('address').toArray(),
        db.custodySegments.toArray()
      ]);
      
      const decryptedRecords = isEncryptionReady() 
        ? await decryptRecords(recordData) 
        : recordData;
      
      setAttestations(attestationData);
      setProofs(proofData);
      setAddresses(decryptedRecords);
      setCustodySegments(segmentData);
      
      const twoYearsAgo = subYears(new Date(), 2);
      setStartDate(format(twoYearsAgo, 'yyyy-MM-dd'));
      setEndDate(format(new Date(), 'yyyy-MM-dd'));
    } catch (error) {
      console.error('Failed to load data:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load compliance data"
      });
    } finally {
      setIsLoading(false);
    }
  }

  function handleAddressSelect(address: string) {
    setSelectedAddress(address);
    const message = generateAttestationMessage(address, {
      purpose: "Ownership attestation for compliance proof"
    });
    setAttestationMessage(message);
  }

  async function handleSaveAttestation() {
    if (!selectedAddress || !signatureInput.trim()) {
      toast({
        variant: "destructive",
        title: "Missing information",
        description: "Please select an address and provide a signature"
      });
      return;
    }

    setIsSaving(true);
    try {
      const { signature, type } = parseSignedMessage(signatureInput);
      
      const record = addresses.find(a => a.inputString === selectedAddress);
      
      const attestation = await createOwnershipAttestation(
        selectedAddress,
        attestationMessage,
        signature,
        type,
        { recordId: record?.id }
      );
      
      await db.ownershipAttestations.add(attestation);
      
      toast({
        title: "Attestation saved",
        description: "Ownership attestation has been stored. Signature verification is pending."
      });
      
      setNewAttestationOpen(false);
      setSelectedAddress("");
      setAttestationMessage("");
      setSignatureInput("");
      loadData();
    } catch (error) {
      console.error('Failed to save attestation:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save attestation"
      });
    } finally {
      setIsSaving(false);
    }
  }

  function toggleAddressSelection(address: string) {
    setSelectedAddresses(prev => {
      const next = new Set(prev);
      if (next.has(address)) {
        next.delete(address);
      } else {
        next.add(address);
      }
      return next;
    });
  }

  function selectAllAddresses() {
    const filtered = filteredAddresses;
    setSelectedAddresses(new Set(filtered.map(a => a.inputString)));
  }

  function clearAddressSelection() {
    setSelectedAddresses(new Set());
  }

  const filteredAddresses = addresses.filter(addr => 
    !addressSearch || 
    addr.inputString.toLowerCase().includes(addressSearch.toLowerCase()) ||
    addr.label?.toLowerCase().includes(addressSearch.toLowerCase()) ||
    addr.owner?.toLowerCase().includes(addressSearch.toLowerCase())
  );

  async function handleGenerateProof() {
    if (!proofName.trim()) {
      toast({
        variant: "destructive",
        title: "Missing name",
        description: "Please provide a name for this proof"
      });
      return;
    }

    if (selectedAddresses.size === 0) {
      toast({
        variant: "destructive",
        title: "No addresses selected",
        description: "Please select at least one address to include in the proof"
      });
      return;
    }

    if (!startDate || !endDate) {
      toast({
        variant: "destructive",
        title: "Missing dates",
        description: "Please specify a date range for the proof"
      });
      return;
    }

    setIsGeneratingProof(true);
    try {
      const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
      const endTimestamp = Math.floor(new Date(endDate).getTime() / 1000);
      
      let filteredSegments = filterSegmentsByAddresses(
        custodySegments, 
        Array.from(selectedAddresses)
      );
      filteredSegments = filterSegmentsByDateRange(
        filteredSegments,
        startTimestamp,
        endTimestamp
      );
      
      const relevantAttestations = attestations.filter(a => 
        selectedAddresses.has(a.address)
      );
      
      const proof = await createComplianceProof(
        proofName,
        filteredSegments,
        relevantAttestations.map(a => a.attestationId),
        {
          description: proofDescription || undefined,
          startDate: startTimestamp,
          endDate: endTimestamp,
          disclosureLevel
        }
      );
      
      await db.complianceProofs.add(proof);
      
      toast({
        title: "Proof generated",
        description: `Created compliance proof with ${proof.totalAddresses} addresses and ${proof.totalTransactions} transactions`
      });
      
      setNewProofOpen(false);
      setProofName("");
      setProofDescription("");
      setSelectedAddresses(new Set());
      loadData();
    } catch (error) {
      console.error('Failed to generate proof:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to generate compliance proof"
      });
    } finally {
      setIsGeneratingProof(false);
    }
  }

  async function handleExportProof(proof: ComplianceProof) {
    try {
      const relevantAttestations = attestations.filter(a => 
        proof.attestationIds.includes(a.attestationId)
      );
      
      const bundle = exportProofBundle(proof, relevantAttestations);
      
      const blob = new Blob([bundle], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${proof.name.replace(/\s+/g, '_')}_compliance_proof.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast({
        title: "Proof exported",
        description: "Compliance proof bundle has been downloaded"
      });
    } catch (error) {
      console.error('Failed to export proof:', error);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to export proof bundle"
      });
    }
  }

  async function handleDeleteAttestation(id: number) {
    try {
      await db.ownershipAttestations.delete(id);
      toast({ title: "Attestation deleted" });
      loadData();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete attestation"
      });
    }
  }

  async function handleDeleteProof(id: number) {
    try {
      await db.complianceProofs.delete(id);
      toast({ title: "Proof deleted" });
      loadData();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete proof"
      });
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  }

  function handleDownloadVerifier() {
    const html = generateStandaloneVerifier();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kyutxo-proof-verifier.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast({
      title: "Verifier downloaded",
      description: "Open the HTML file in any browser to verify compliance proofs"
    });
  }

  function getStatusIcon(status: AttestationStatus) {
    switch (status) {
      case 'verified':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'pending':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'expired':
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  }

  function getStatusBadge(status: AttestationStatus) {
    switch (status) {
      case 'verified':
        return <Badge className="bg-green-600">Verified</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-600">Pending</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'expired':
        return <Badge variant="secondary">Expired</Badge>;
    }
  }

  function getDisclosureBadge(level: ProofDisclosureLevel) {
    switch (level) {
      case 'full':
        return <Badge className="bg-blue-600">Full</Badge>;
      case 'addresses-hidden':
        return <Badge className="bg-purple-600">Addresses Hidden</Badge>;
      case 'amounts-hidden':
        return <Badge className="bg-orange-600">Amounts Hidden</Badge>;
      case 'minimal':
        return <Badge variant="secondary">Minimal</Badge>;
      case 'custom':
        return <Badge variant="outline">Custom</Badge>;
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Shield className="h-6 w-6" />
              Compliance Proofs
            </h1>
            <p className="text-muted-foreground mt-1">
              Manage ownership attestations and generate selective custody proofs
            </p>
          </div>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Privacy-Preserving Compliance</AlertTitle>
          <AlertDescription>
            Generate cryptographic proofs of your custody history without exposing your entire transaction history.
            Select specific addresses and time periods to include in compliance bundles.
          </AlertDescription>
        </Alert>

        <Tabs defaultValue="attestations" className="w-full">
          <TabsList>
            <TabsTrigger value="attestations" className="gap-2" data-testid="tab-attestations">
              <FileSignature className="h-4 w-4" />
              Ownership Attestations ({attestations.length})
            </TabsTrigger>
            <TabsTrigger value="proofs" className="gap-2" data-testid="tab-proofs">
              <FileCheck className="h-4 w-4" />
              Compliance Proofs ({proofs.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="attestations" className="space-y-4 mt-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Ownership Attestations</h2>
                <p className="text-sm text-muted-foreground">
                  Signed messages proving you control specific addresses
                </p>
              </div>
              <Button onClick={() => setNewAttestationOpen(true)} data-testid="button-new-attestation">
                <Plus className="h-4 w-4 mr-2" />
                New Attestation
              </Button>
            </div>

            {attestations.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Key className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">No Attestations Yet</h3>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto mb-4">
                    Create ownership attestations by signing messages with your wallet software
                    to prove you control specific addresses.
                  </p>
                  <Button onClick={() => setNewAttestationOpen(true)} data-testid="button-create-first-attestation">
                    <Plus className="h-4 w-4 mr-2" />
                    Create First Attestation
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {attestations.map((attestation) => (
                  <Card key={attestation.id} data-testid={`card-attestation-${attestation.id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-2 min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {getStatusIcon(attestation.status)}
                            <span className="font-mono text-sm truncate">
                              {attestation.address}
                            </span>
                            {getStatusBadge(attestation.status)}
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span>Type: {attestation.signatureType}</span>
                            <span>Created: {formatDistanceToNow(attestation.createdAt, { addSuffix: true })}</span>
                            {attestation.validFrom && attestation.validUntil && (
                              <span>
                                Valid: {format(attestation.validFrom * 1000, 'MMM d, yyyy')} - {format(attestation.validUntil * 1000, 'MMM d, yyyy')}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => copyToClipboard(attestation.signature)}
                            data-testid={`button-copy-signature-${attestation.id}`}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => attestation.id && handleDeleteAttestation(attestation.id)}
                            data-testid={`button-delete-attestation-${attestation.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="proofs" className="space-y-4 mt-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Compliance Proofs</h2>
                <p className="text-sm text-muted-foreground">
                  Merkle-based custody proofs with selective disclosure
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={handleDownloadVerifier} data-testid="button-download-verifier">
                  <Download className="h-4 w-4 mr-2" />
                  Download Verifier
                </Button>
                <Button onClick={() => setNewProofOpen(true)} data-testid="button-new-proof">
                  <Plus className="h-4 w-4 mr-2" />
                  New Proof
                </Button>
              </div>
            </div>

            {proofs.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Lock className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">No Proofs Generated</h3>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto mb-4">
                    Generate compliance proofs by selecting addresses and date ranges.
                    Proofs use merkle trees for selective disclosure.
                  </p>
                  <Button onClick={() => setNewProofOpen(true)} data-testid="button-create-first-proof">
                    <Plus className="h-4 w-4 mr-2" />
                    Create First Proof
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {proofs.map((proof) => (
                  <Card key={proof.id} data-testid={`card-proof-${proof.id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-2 min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <FileCheck className="h-4 w-4 text-primary" />
                            <span className="font-medium">{proof.name}</span>
                            {getDisclosureBadge(proof.disclosureLevel)}
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span>{proof.totalAddresses} addresses</span>
                            <span>{proof.totalTransactions} transactions</span>
                            {proof.totalAmountSats && (
                              <span>{(proof.totalAmountSats / 100_000_000).toFixed(8)} BTC</span>
                            )}
                            <span>
                              {format(proof.startDate * 1000, 'MMM yyyy')} - {format(proof.endDate * 1000, 'MMM yyyy')}
                            </span>
                          </div>
                          {proof.description && (
                            <p className="text-sm text-muted-foreground">{proof.description}</p>
                          )}
                          <div className="text-xs text-muted-foreground">
                            Merkle Root: <span className="font-mono">{proof.merkleRoot.slice(0, 16)}...</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            onClick={() => handleExportProof(proof)}
                            data-testid={`button-export-proof-${proof.id}`}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            onClick={() => proof.id && handleDeleteProof(proof.id)}
                            data-testid={`button-delete-proof-${proof.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <Dialog open={newAttestationOpen} onOpenChange={setNewAttestationOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileSignature className="h-5 w-5" />
                New Ownership Attestation
              </DialogTitle>
              <DialogDescription>
                Generate a message to sign with your wallet software, then paste the signature here.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Select Address</Label>
                <Select value={selectedAddress} onValueChange={handleAddressSelect}>
                  <SelectTrigger data-testid="select-address">
                    <SelectValue placeholder="Choose an address to attest" />
                  </SelectTrigger>
                  <SelectContent>
                    {addresses.map((addr) => (
                      <SelectItem 
                        key={addr.id} 
                        value={addr.inputString}
                        data-testid={`select-address-option-${addr.id}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs truncate max-w-[300px]">
                            {addr.inputString}
                          </span>
                          {addr.label && (
                            <Badge variant="secondary" className="text-xs">{addr.label}</Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedAddress && (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Message to Sign</Label>
                      <Button 
                        size="sm" 
                        variant="ghost" 
                        onClick={() => copyToClipboard(attestationMessage)}
                        data-testid="button-copy-message"
                      >
                        <Copy className="h-4 w-4 mr-1" />
                        Copy
                      </Button>
                    </div>
                    <div className="bg-muted p-3 rounded-md font-mono text-xs whitespace-pre-wrap">
                      {attestationMessage}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Copy this message and sign it using your wallet software (Sparrow, Electrum, etc.)
                    </p>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label>Paste Signature</Label>
                    <Textarea
                      value={signatureInput}
                      onChange={(e) => setSignatureInput(e.target.value)}
                      placeholder="Paste the signature from your wallet here..."
                      className="font-mono text-xs min-h-[100px]"
                      data-testid="input-signature"
                    />
                    <p className="text-xs text-muted-foreground">
                      Supported formats: Base64, Hex, or Electrum-style signed message
                    </p>
                  </div>
                </>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setNewAttestationOpen(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSaveAttestation} 
                disabled={!selectedAddress || !signatureInput.trim() || isSaving}
                data-testid="button-save-attestation"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Save Attestation
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={newProofOpen} onOpenChange={setNewProofOpen}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileCheck className="h-5 w-5" />
                Generate Compliance Proof
              </DialogTitle>
              <DialogDescription>
                Select addresses and date range to include in your selective disclosure proof.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 overflow-y-auto flex-1 pr-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="proof-name">Proof Name</Label>
                  <Input
                    id="proof-name"
                    value={proofName}
                    onChange={(e) => setProofName(e.target.value)}
                    placeholder="e.g., 2024 Tax Compliance"
                    data-testid="input-proof-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="disclosure-level">Disclosure Level</Label>
                  <Select value={disclosureLevel} onValueChange={(v) => setDisclosureLevel(v as ProofDisclosureLevel)}>
                    <SelectTrigger data-testid="select-disclosure-level">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">
                        <div className="flex items-center gap-2">
                          <Eye className="h-4 w-4" />
                          Full - All details visible
                        </div>
                      </SelectItem>
                      <SelectItem value="addresses-hidden">
                        <div className="flex items-center gap-2">
                          <EyeOff className="h-4 w-4" />
                          Addresses Hidden
                        </div>
                      </SelectItem>
                      <SelectItem value="amounts-hidden">
                        <div className="flex items-center gap-2">
                          <EyeOff className="h-4 w-4" />
                          Amounts Hidden
                        </div>
                      </SelectItem>
                      <SelectItem value="minimal">
                        <div className="flex items-center gap-2">
                          <Lock className="h-4 w-4" />
                          Minimal - Only merkle root
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="proof-description">Description (Optional)</Label>
                <Textarea
                  id="proof-description"
                  value={proofDescription}
                  onChange={(e) => setProofDescription(e.target.value)}
                  placeholder="Purpose of this proof..."
                  className="min-h-[60px]"
                  data-testid="input-proof-description"
                />
              </div>

              <Separator />

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start-date">Start Date</Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    data-testid="input-start-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end-date">End Date</Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    data-testid="input-end-date"
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Select Addresses ({selectedAddresses.size} selected)</Label>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={selectAllAddresses} data-testid="button-select-all">
                      Select All
                    </Button>
                    <Button size="sm" variant="outline" onClick={clearAddressSelection} data-testid="button-clear-selection">
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={addressSearch}
                    onChange={(e) => setAddressSearch(e.target.value)}
                    placeholder="Search addresses..."
                    className="pl-10"
                    data-testid="input-address-search"
                  />
                </div>
                <ScrollArea className="h-[200px] border rounded-md p-2">
                  {filteredAddresses.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground text-sm">
                      No addresses found
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredAddresses.map((addr) => (
                        <div 
                          key={addr.id}
                          className="flex items-center gap-3 p-2 rounded-md hover-elevate cursor-pointer"
                          onClick={() => toggleAddressSelection(addr.inputString)}
                          data-testid={`checkbox-address-${addr.id}`}
                        >
                          <Checkbox 
                            checked={selectedAddresses.has(addr.inputString)}
                            onCheckedChange={() => toggleAddressSelection(addr.inputString)}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-xs truncate">{addr.inputString}</div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {addr.label && <span>{addr.label}</span>}
                              {addr.owner && <span>Owner: {addr.owner}</span>}
                            </div>
                          </div>
                          {attestations.some(a => a.address === addr.inputString) && (
                            <Badge variant="secondary" className="text-xs shrink-0">
                              <FileSignature className="h-3 w-3 mr-1" />
                              Attested
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>

              {selectedAddresses.size > 0 && (
                <Alert>
                  <Shield className="h-4 w-4" />
                  <AlertTitle>Proof Preview</AlertTitle>
                  <AlertDescription>
                    This proof will cover {selectedAddresses.size} address{selectedAddresses.size !== 1 ? 'es' : ''} from{' '}
                    {startDate ? format(new Date(startDate), 'MMM d, yyyy') : '?'} to{' '}
                    {endDate ? format(new Date(endDate), 'MMM d, yyyy') : '?'} with{' '}
                    {disclosureLevel === 'full' ? 'full disclosure' : 
                     disclosureLevel === 'addresses-hidden' ? 'addresses hidden' :
                     disclosureLevel === 'amounts-hidden' ? 'amounts hidden' : 'minimal disclosure'}.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => setNewProofOpen(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleGenerateProof}
                disabled={!proofName.trim() || selectedAddresses.size === 0 || isGeneratingProof}
                data-testid="button-generate-proof"
              >
                {isGeneratingProof ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Shield className="h-4 w-4 mr-2" />
                    Generate Proof
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
