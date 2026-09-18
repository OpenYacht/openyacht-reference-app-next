import { Alert, AlertContent, AlertDescription, AlertTitle } from "@heroui/react";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { setup } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-16">
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
