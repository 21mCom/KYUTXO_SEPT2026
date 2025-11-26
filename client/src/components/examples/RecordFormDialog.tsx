import { useState } from "react";
import { RecordFormDialog } from "../RecordFormDialog";
import { Button } from "@/components/ui/button";

export default function RecordFormDialogExample() {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-4">
      <Button onClick={() => setOpen(true)} data-testid="button-open-form">
        Open Form
      </Button>
      <RecordFormDialog
        open={open}
        onClose={() => setOpen(false)}
        onSave={(data) => {
          console.log("Saved:", data);
          setOpen(false);
        }}
      />
    </div>
  );
}
