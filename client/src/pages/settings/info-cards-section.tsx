import { Link } from "wouter";
import { Database, Stethoscope, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { version as APP_VERSION } from "../../../../package.json";
import { isElectron, getElectronAPISafe } from "@/lib/electron";

export function StorageCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          Storage
        </CardTitle>
        <CardDescription>
          Information about local data storage
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Storage Type</span>
          <Badge variant="secondary">IndexedDB (Offline)</Badge>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Data Location</span>
          <span className="text-sm font-mono">Local Device</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Storage Used</span>
          <span className="text-sm font-medium" data-testid="text-storage">2.1 MB</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function DatabaseDoctorCard() {
  return (
    <Card data-testid="card-database-doctor-link">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="h-5 w-5" />
          Database Doctor
        </CardTitle>
        <CardDescription>
          A safe, read-only health check that tells you in plain language whether your records
          are actually there and readable — or still locked from an unfinished migration.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/database-doctor">
          <Button variant="outline" data-testid="button-open-database-doctor">
            Open Database Doctor
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

export function AboutCard() {
  const inElectron = isElectron();
  const electronVersion = getElectronAPISafe()?.electronVersion;

  return (
    <Card>
      <CardHeader>
        <CardTitle>About KYUTXO</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Version</span>
          <span className="font-medium" data-testid="text-app-version">{APP_VERSION}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Type</span>
          <Badge variant="outline">
            {inElectron ? "Desktop App" : "Progressive Web App"}
          </Badge>
        </div>
        {inElectron && electronVersion && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Electron</span>
            <span className="font-medium font-mono" data-testid="text-electron-version">
              {electronVersion}
            </span>
          </div>
        )}
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Privacy</span>
          <span className="font-medium">All data stored locally</span>
        </div>
      </CardContent>
    </Card>
  );
}
