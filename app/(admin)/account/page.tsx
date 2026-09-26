import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@heroui/react";
import { requireSession } from "@/lib/auth/session";
import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const session = await requireSession();
  // Arriving from an invitation or reset link: the person is signed in by the
  // link and has no password they know yet.
  const choosing = (await searchParams).choose === "password";

  return (
    <main className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Your account</h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Email</dt>
        <dd>{session.email}</dd>
        <dt className="text-muted">Role</dt>
        <dd>{session.role ?? "none: ask an administrator for one"}</dd>
      </dl>
      <Card>
        <CardHeader>
          <CardTitle>{choosing ? "Choose a password" : "Change your password"}</CardTitle>
          <CardDescription>
            {choosing
              ? "You are signed in by the link, which now cannot be used again. Choose the password you will sign in with."
              : "Takes effect at once."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm email={session.email ?? ""} />
        </CardContent>
      </Card>
    </main>
  );
}
