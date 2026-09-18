import { Alert, AlertContent, AlertDescription, AlertTitle, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@heroui/react";
import { redirect } from "next/navigation";
import { checkSetupReadiness, isDisposableDomain, MIN_PASSWORD_LENGTH } from "@/lib/node/setup";
import { isSetupComplete } from "@/lib/node/setup-state";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isSetupComplete().catch(() => false)) redirect("/");
  const { identity, problems } = await checkSetupReadiness();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG; the image optimiser adds nothing */}
      <img src="/brand/openyacht-lockup.svg" alt="OpenYacht" width={161} height={40} className="h-10 w-auto self-start" />
      <header>
        <h1 className="text-2xl font-semibold">Set up this OpenYacht node</h1>
        <p className="text-muted mt-2">One-time setup: the first administrator, the node&apos;s UUID, and its signing key.</p>
      </header>

      {problems.length > 0 || identity === null ? (
        <Alert status="danger">
          <AlertContent>
            <AlertTitle>The configuration needs attention before setup can run</AlertTitle>
            <AlertDescription>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
              <p className="mt-3">Fix these in the environment, restart the server, and reload this page.</p>
            </AlertDescription>
          </AlertContent>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>The identity domain is permanent</CardTitle>
              <CardDescription>
                This node will identify itself to every partner as <strong className="font-mono">{identity.domain}</strong>, named{" "}
                <strong>{identity.name}</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                The domain is part of every listing&apos;s canonical URI, and partners store those URIs for good. There is no rename: moving to
                another domain later means a new node with new listings, and every partner starts again.
              </p>
              <p>
                Choose a hostname under the domain partners already know the business by — a dedicated subdomain is the recommended pattern. To use a
                different one, change OPENYACHT_DOMAIN now, before completing this page.
              </p>
              {isDisposableDomain(identity.domain) && (
                <p className="font-medium">
                  {identity.domain} is a hostname issued by a hosting platform. It is fine for trying the software out and wrong for a real node.
                </p>
              )}
            </CardContent>
          </Card>
          <SetupForm domain={identity.domain} disposable={isDisposableDomain(identity.domain)} minPasswordLength={MIN_PASSWORD_LENGTH} />
        </>
      )}
    </main>
  );
}
