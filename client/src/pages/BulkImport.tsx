import { useState } from "react";
import { Key, ChevronRight, ChevronLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function BulkImport() {
  const [step, setStep] = useState(1);
  const [xpub, setXpub] = useState("");
  const [derivationPath, setDerivationPath] = useState("m/84'/0'/0'/0");
  const [addressCount, setAddressCount] = useState(20);

  const mockAddresses = Array.from({ length: 5 }, (_, i) => ({
    index: i,
    address: `bc1q${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`,
    path: `${derivationPath}/${i}`,
  }));

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Bulk Address Import</h1>
          <p className="text-muted-foreground">
            Derive multiple addresses from an extended public key (xpub/ypub/zpub)
          </p>
        </div>

        <div className="flex items-center gap-2 mb-6">
          <div className={`flex items-center gap-2 ${step >= 1 ? "text-primary" : "text-muted-foreground"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 1 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {step > 1 ? <Check className="h-4 w-4" /> : "1"}
            </div>
            <span className="text-sm font-medium">Enter Key</span>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <div className={`flex items-center gap-2 ${step >= 2 ? "text-primary" : "text-muted-foreground"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 2 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {step > 2 ? <Check className="h-4 w-4" /> : "2"}
            </div>
            <span className="text-sm font-medium">Configure</span>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <div className={`flex items-center gap-2 ${step >= 3 ? "text-primary" : "text-muted-foreground"}`}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${step >= 3 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              3
            </div>
            <span className="text-sm font-medium">Preview & Save</span>
          </div>
        </div>

        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                Extended Public Key
              </CardTitle>
              <CardDescription>
                Enter your xpub, ypub, or zpub key to derive addresses
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="xpub">Extended Public Key</Label>
                <Input
                  id="xpub"
                  value={xpub}
                  onChange={(e) => setXpub(e.target.value)}
                  placeholder="xpub6D..."
                  className="font-mono text-sm"
                  data-testid="input-xpub"
                />
                <p className="text-xs text-muted-foreground">
                  Supported formats: xpub (P2PKH), ypub (P2WPKH-P2SH), zpub (P2WPKH)
                </p>
              </div>
              <Button
                className="w-full"
                onClick={() => setStep(2)}
                disabled={!xpub}
                data-testid="button-next-step1"
              >
                Continue
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Derivation Options</CardTitle>
              <CardDescription>
                Configure how addresses should be derived
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="path">Derivation Path</Label>
                <Select value={derivationPath} onValueChange={setDerivationPath}>
                  <SelectTrigger id="path" data-testid="select-path">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="m/84'/0'/0'/0">m/84'/0'/0'/0 (Native SegWit - External)</SelectItem>
                    <SelectItem value="m/84'/0'/0'/1">m/84'/0'/0'/1 (Native SegWit - Change)</SelectItem>
                    <SelectItem value="m/49'/0'/0'/0">m/49'/0'/0'/0 (SegWit - External)</SelectItem>
                    <SelectItem value="m/44'/0'/0'/0">m/44'/0'/0'/0 (Legacy - External)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="count">Number of Addresses</Label>
                <Input
                  id="count"
                  type="number"
                  value={addressCount}
                  onChange={(e) => setAddressCount(Number(e.target.value))}
                  min={1}
                  max={100}
                  data-testid="input-count"
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)} data-testid="button-back">
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button className="flex-1" onClick={() => setStep(3)} data-testid="button-next-step2">
                  Generate Preview
                  <ChevronRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Preview Addresses</CardTitle>
              <CardDescription>
                Review the generated addresses before saving
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                {mockAddresses.map((addr) => (
                  <div
                    key={addr.index}
                    className="flex items-center justify-between p-3 border rounded hover-elevate"
                    data-testid={`address-preview-${addr.index}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-xs">
                          #{addr.index}
                        </Badge>
                        <code className="text-xs text-muted-foreground">{addr.path}</code>
                      </div>
                      <code className="text-sm font-mono break-all">{addr.address}</code>
                    </div>
                  </div>
                ))}
                <p className="text-sm text-muted-foreground text-center py-2">
                  Showing 5 of {addressCount} addresses
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(2)} data-testid="button-back-step3">
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => {
                    console.log("Save addresses");
                    alert("Addresses saved successfully!");
                  }}
                  data-testid="button-save-addresses"
                >
                  <Check className="h-4 w-4 mr-2" />
                  Save {addressCount} Addresses
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
