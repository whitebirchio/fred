"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { NavLink } from "./ui";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/savings", label: "Savings" },
  { href: "/accounts", label: "Accounts" },
  { href: "/house", label: "House" },
  { href: "/income", label: "Income" },
  { href: "/monthly", label: "Monthly close" },
];

export function Nav() {
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
      </div>
    </header>
  );
}
