import { Alert, AlertContent, AlertDescription, AlertTitle } from "@heroui/react";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { setup } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-16">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG; the image optimiser adds nothing */}
      <img src="/brand/openyacht-lockup.svg" alt="OpenYacht" width={161} height={40} className="h-10 w-auto self-start" />
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {setup === "complete" && (
        <Alert status="success">
          <AlertContent>
            <AlertTitle>Setup complete</AlertTitle>
            <AlertDescription>Sign in with the administrator account you just created.</AlertDescription>
          </AlertContent>
        </Alert>
      )}
      <LoginForm />
    </main>
  );
}
