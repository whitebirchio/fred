import { redirect } from "next/navigation";

// The account list retired into /household (docs/HOUSEHOLD.md decision 3);
// the per-account detail view /accounts/[slug] lives on. Redirect any old
// link or bookmark to the roster.
export default function AccountsPage() {
  redirect("/household");
}
