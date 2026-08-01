import { loadHousehold } from "@/lib/household";
import { getScope, scopeLabel } from "@/lib/scope";
import { PageHeader } from "@/components/ui";
import { HouseholdClient } from "@/components/household-client";

export const dynamic = "force-dynamic";

export default async function HouseholdPage() {
  const [scope, { accounts, pending, ignored, people, primaryPersonId }] =
    await Promise.all([getScope(), loadHousehold()]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Household"
        subtitle={`Every account, across every source. One row per real account — sources are evidence about it, not separate accounts. Showing: ${scopeLabel(scope, people)}.`}
      />
      <HouseholdClient
        accounts={accounts}
        pending={pending}
        ignored={ignored}
        people={people}
        scope={scope}
        primaryPersonId={primaryPersonId}
      />
    </div>
  );
}
