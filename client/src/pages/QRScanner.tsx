import { useState, useRef, useEffect, useCallback } from "react";
import { QrCode, Camera, X, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import jsQR from "jsqr";

export default function QRScanner() {
  const [scanning, setScanning] = useState(false);
  const [scannedData, setScannedData] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);
  const { toast } = useToast();

  const stopCamera = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const scanFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !scanning) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    if (!ctx || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animationRef.current = requestAnimationFrame(scanFrame);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });

    if (code) {
      setScannedData(code.data);
      setScanning(false);
      stopCamera();
      toast({
        title: "QR Code Detected",
        description: "Successfully scanned QR code data",
      });
    } else {
      animationRef.current = requestAnimationFrame(scanFrame);
    }
  }, [scanning, stopCamera, toast]);

  const startScan = async () => {
    setCameraError(null);
    setScannedData(null);
    setScanning(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: "environment",
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });

      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        
        videoRef.current.onloadedmetadata = () => {
          if (videoRef.current) {
            videoRef.current.play().catch(err => {
              console.error("Video play error:", err);
            });
          }
        };
      }
    } catch (err) {
      console.error("Camera access error:", err);
      setScanning(false);
      if (err instanceof Error) {
        if (err.name === "NotAllowedError") {
          setCameraError("Camera access was denied. Please allow camera permissions and try again.");
        } else if (err.name === "NotFoundError") {
          setCameraError("No camera found on this device.");
        } else {
          setCameraError(`Camera error: ${err.message}`);
        }
      } else {
        setCameraError("Failed to access camera. Please check your permissions.");
      }
    }
  };

  useEffect(() => {
    if (scanning && videoRef.current) {
      animationRef.current = requestAnimationFrame(scanFrame);
    }
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [scanning, scanFrame]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const handleCancel = () => {
    setScanning(false);
    stopCamera();
  };

  const detectAddressType = (data: string): string => {
    if (data.startsWith("bitcoin:")) {
      return "Bitcoin URI";
    } else if (data.match(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/)) {
      return "Bitcoin Address (Legacy)";
    } else if (data.match(/^bc1[a-z0-9]{39,59}$/i)) {
      return "Bitcoin Address (Bech32)";
    } else if (data.match(/^[a-fA-F0-9]{64}$/)) {
      return "Transaction ID";
    } else {
      return "Unknown Data";
    }
  };

  const extractAddress = (data: string): string => {
    if (data.startsWith("bitcoin:")) {
      const match = data.match(/^bitcoin:([^?]+)/);
      return match ? match[1] : data;
    }
    return data;
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
            {cameraError && (
              <Alert variant="destructive">
                <AlertDescription>{cameraError}</AlertDescription>
              </Alert>
            )}

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
              <div className="flex flex-col items-center justify-center space-y-4">
                <div className="relative w-full max-w-sm aspect-square rounded-lg overflow-hidden border-4 border-primary bg-black">
                  <video
                    ref={videoRef}
                    className="w-full h-full object-cover"
                    autoPlay
                    playsInline
                    muted
                  />
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-primary"></div>
                    <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-primary"></div>
                    <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-primary"></div>
                    <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-primary"></div>
                  </div>
                  <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-primary/50 animate-pulse"></div>
                </div>
                <canvas ref={canvasRef} className="hidden" />
                <Badge variant="secondary" className="animate-pulse">
                  Scanning for QR codes...
                </Badge>
                <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-scan">
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              </div>
            )}

            {scannedData && (
              <div className="space-y-4">
                <Alert>
                  <CheckCircle className="h-4 w-4" />
                  <AlertDescription>
                    Successfully scanned: {detectAddressType(scannedData)}
                  </AlertDescription>
                </Alert>
                <div className="p-4 bg-muted rounded-lg">
                  <Label className="text-sm font-medium mb-2 block">Scanned Data</Label>
                  <code className="text-sm font-mono break-all" data-testid="text-scanned-data">
                    {extractAddress(scannedData)}
                  </code>
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    onClick={() => {
                      const address = extractAddress(scannedData);
                      navigator.clipboard.writeText(address);
                      toast({
                        title: "Copied",
                        description: "Address copied to clipboard",
                      });
                    }}
                    data-testid="button-copy-scanned"
                  >
                    Copy to Clipboard
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setScannedData(null);
                      setCameraError(null);
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
            <CardTitle>Tips</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>• Hold your device steady and ensure the QR code is well-lit</p>
            <p>• Position the QR code within the scanning frame</p>
            <p>• Supports Bitcoin addresses, transaction IDs, and bitcoin: URIs</p>
            <p>• Camera access is required - you'll be prompted for permission</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
