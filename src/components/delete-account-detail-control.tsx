"use client";

import { useRouter } from "next/navigation";
import { DeleteAccountControl } from "@/components/delete-account-control";

/** Account detail page usage: after deleting, the page you're standing on no
 *  longer exists, so navigate back to the roster instead of refetching it. */
export function DeleteAccountDetailControl({
  accountId,
  accountName,
}: {
  accountId: number;
  accountName: string;
}) {
  const router = useRouter();
  return (
    <DeleteAccountControl
      accountId={accountId}
      accountName={accountName}
      onDeleted={() => router.push("/household")}
    />
  );
}
