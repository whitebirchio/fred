import { ReactNode } from "react";
import Link from "next/link";

export function Card({
  title,
  subtitle,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-edge bg-surface p-4 sm:p-5 ${className}`}
    >
      {title && (
        <header className="mb-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  delta,
  deltaGood,
  sub,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaGood?: boolean;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-ink tabular-nums">
        {value}
      </div>
      {(delta || sub) && (
        <div className="mt-1 flex items-baseline gap-2 text-xs">
          {delta && (
            <span
              className={`font-medium tabular-nums ${
                deltaGood === undefined
                  ? "text-ink-2"
                  : deltaGood
                    ? "text-good"
                    : "text-bad"
              }`}
            >
              {delta}
            </span>
          )}
          {sub && <span className="text-ink-3">{sub}</span>}
        </div>
      )}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-3">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function NavLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-surface-2 text-ink"
          : "text-ink-2 hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}
