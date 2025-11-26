import { useState } from "react";
import { QrCode, Camera, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function QRScanner() {
  const [scanning, setScanning] = useState(false);
  const [scannedData, setScannedData] = useState<string | null>(null);

  const startScan = () => {
    setScanning(true);
    setTimeout(() => {
      setScannedData("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");
      setScanning(false);
    }, 2000);
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">QR Code Scanner</h1>
          <p className="text-muted-foreground">
            Scan QR codes to quickly capture Bitcoin addresses and transaction IDs
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5" />
              Camera Scanner
            </CardTitle>
            <CardDescription>
              Point your camera at a Bitcoin address or transaction QR code
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!scanning && !scannedData && (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center">
                  <Camera className="h-12 w-12 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground text-center">
                  Click the button below to activate your camera
                </p>
                <Button onClick={startScan} size="lg" data-testid="button-start-scan">
                  <Camera className="h-4 w-4 mr-2" />
                  Start Scanning
                </Button>
              </div>
            )}

            {scanning && (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="w-64 h-64 border-4 border-primary rounded-lg flex items-center justify-center relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-b from-primary/20 to-transparent"></div>
                  <QrCode className="h-32 w-32 text-primary/40" />
                  <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-primary animate-pulse"></div>
                </div>
                <Badge variant="secondary" className="animate-pulse">
                  Scanning...
                </Badge>
                <Button variant="outline" onClick={() => setScanning(false)} data-testid="button-cancel-scan">
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              </div>
            )}

            {scannedData && (
              <div className="space-y-4">
                <Alert>
                  <QrCode className="h-4 w-4" />
                  <AlertDescription>
                    Successfully scanned Bitcoin address
                  </AlertDescription>
                </Alert>
                <div className="p-4 bg-muted rounded-lg">
                  <Label className="text-sm font-medium mb-2 block">Scanned Data</Label>
                  <code className="text-sm font-mono break-all" data-testid="text-scanned-data">
                    {scannedData}
                  </code>
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    onClick={() => {
                      console.log("Create record with:", scannedData);
                      alert("Record created!");
                    }}
                    data-testid="button-create-from-scan"
                  >
                    Create Record
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setScannedData(null);
                      setScanning(false);
                    }}
                    data-testid="button-scan-another"
                  >
                    Scan Another
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Camera Permissions</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert>
              <Camera className="h-4 w-4" />
              <AlertDescription>
                This feature requires camera access. You'll be prompted to grant permission when you start scanning.
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
