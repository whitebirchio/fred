"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { NavLink } from "./ui";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/plan", label: "Plan" },
  { href: "/savings", label: "Savings" },
  { href: "/household", label: "Household" },
  { href: "/house", label: "House" },
  { href: "/income", label: "Income" },
  { href: "/monthly", label: "Monthly close" },
  { href: "/sync", label: "Sync" },
];

export function Nav({
  email,
  logoutUrl,
}: {
  email?: string | null;
  logoutUrl?: string | null;
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">
            F
          </span>
          <span className="text-sm font-semibold tracking-tight text-ink">Fred</span>
        </Link>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((l) => (
            <NavLink
              key={l.href}
              href={l.href}
              label={l.label}
              active={
                l.href === "/" ? pathname === "/" : pathname.startsWith(l.href)
              }
            />
          ))}
        </nav>
        {/* Absent in local dev, where there is no session to show. */}
        {email && (
          <div className="hidden shrink-0 items-center gap-2 text-[11px] text-ink-3 sm:flex">
            <span title="Verified by Cloudflare Access">{email}</span>
            {logoutUrl && (
              <a href={logoutUrl} className="hover:text-ink-2 hover:underline">
                Sign out
              </a>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
