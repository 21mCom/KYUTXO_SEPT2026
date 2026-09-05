import VocabularyManager from "@/components/VocabularyManager";
import StripMarkersPanel from "@/components/StripMarkersPanel";
import MigrationAuditPanel from "@/components/MigrationAuditPanel";
import LegacyRecoveryPanel from "@/components/LegacyRecoveryPanel";
import NeedsReviewPanel from "@/components/NeedsReviewPanel";
import { AppearanceSection } from "./settings/appearance-section";
import { FieldVisibilitySection } from "./settings/field-visibility-section";
import { AnalysisLimitsSection } from "./settings/analysis-limits-section";
import { EntityListSection } from "./settings/entity-list-section";
import { HoverTooltipSection } from "./settings/hover-tooltip-section";
import { StorageCard, DatabaseDoctorCard, AboutCard } from "./settings/info-cards-section";
import { SecurityAttachmentSection } from "./settings/security-attachment-section";
import { DataManagementSection } from "./settings/data-management-section";
import { OwnersSection } from "./settings/owners-section";
export { resetEntityErrorOpenState } from "./settings/entity-errors";

export default function SettingsPage() {
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold mb-2">Settings</h1>
          <p className="text-muted-foreground">
            Configure your KYUTXO application preferences
          </p>
        </div>

        <AppearanceSection />
        <FieldVisibilitySection />
        <OwnersSection />
        <VocabularyManager />
        <AnalysisLimitsSection />
        <EntityListSection />
        <HoverTooltipSection />
        <StorageCard />
        <DatabaseDoctorCard />
        <NeedsReviewPanel />
        <LegacyRecoveryPanel />
        <StripMarkersPanel />
        <MigrationAuditPanel />
        <SecurityAttachmentSection />
        <DataManagementSection />
        <AboutCard />
      </div>
    </div>
  );
}
