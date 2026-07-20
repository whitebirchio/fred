import { loadHousehold } from "@/lib/household";
import { PageHeader } from "@/components/ui";
import { HouseholdClient } from "@/components/household-client";

export const dynamic = "force-dynamic";

export default async function HouseholdPage() {
  const { accounts, pending, ignored, people } = await loadHousehold();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Household"
        subtitle="Every account, across every source. One row per real account — sources are evidence about it, not separate accounts."
      />
      <HouseholdClient
        accounts={accounts}
        pending={pending}
        ignored={ignored}
        people={people}
      />
    </div>
  );
}
