import { RecordTypeBadge } from "../RecordTypeBadge";

export default function RecordTypeBadgeExample() {
  return (
    <div className="flex gap-2 p-4">
      <RecordTypeBadge type="address" />
      <RecordTypeBadge type="transaction" />
    </div>
  );
}
