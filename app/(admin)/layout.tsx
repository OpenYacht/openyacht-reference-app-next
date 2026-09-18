import { Button } from "@heroui/react";
import Link from "next/link";
import { signOutAction } from "@/app/login/actions";
import { hasRole, requireSession } from "@/lib/auth/session";

export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const session = await requireSession();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8">
      <header className="border-border flex flex-wrap items-center justify-between gap-4 border-b pb-4">
        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link href="/" className="flex items-center gap-3 text-base font-semibold">
            {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG; the image optimiser adds nothing */}
            <img src="/brand/openyacht-mark.svg" alt="" width={15} height={32} className="h-8 w-auto" />
            OpenYacht node
          </Link>
          {session.role !== null && <Link href="/listings">Listings</Link>}
          {hasRole(session, "super_admin") && <Link href="/partners">Partners</Link>}
          {session.role !== null && <Link href="/copies">Partner listings</Link>}
        </nav>
        <form action={signOutAction} className="flex items-center gap-3">
          <span className="text-muted text-sm">
            {session.email} · {session.role ?? "no role"}
          </span>
          <Button type="submit" variant="secondary" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      {children}
    </div>
  );
}
