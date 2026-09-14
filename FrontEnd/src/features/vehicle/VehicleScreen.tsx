import { useNavigate } from "react-router";
import { PageShell } from "@/components/common/PageShell";
import { VehiclePicker } from "@/features/vehicle/components/VehiclePicker";

export default function VehicleScreen() {
  const navigate = useNavigate();

  return (
    <PageShell>
      <h1 className="text-title font-semibold tracking-tight">Which vehicle?</h1>
      <p className="text-body text-muted-foreground mt-2 max-w-[38ch]">
        Everything I look up is scoped to this. Getting it right is worth the ten
        seconds.
      </p>

      <div className="mt-6">
        <VehiclePicker onPick={() => void navigate(-1)} />
      </div>
    </PageShell>
  );
}
