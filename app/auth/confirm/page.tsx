import { ConfirmForm } from "./confirm-form";

// The landing page of a one-time link. It spends nothing on arrival: mail
// scanners and link previews fetch URLs, and a token verified on GET would be
// gone before its owner clicked. The person presses the button; that POST
// verifies it.
export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const { token_hash: tokenHash, type } = await searchParams;
  const invitation = type !== "recovery";

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 px-4 py-16">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG; the image optimiser adds nothing */}
      <img src="/brand/openyacht-lockup.svg" alt="OpenYacht" width={161} height={40} className="h-10 w-auto self-start" />
      <h1 className="text-2xl font-semibold">{invitation ? "Accept your invitation" : "Reset your password"}</h1>
      {typeof tokenHash === "string" && tokenHash !== "" ? (
        <ConfirmForm tokenHash={tokenHash} type={invitation ? "invite" : "recovery"} />
      ) : (
        <p className="text-sm">This link is incomplete. Copy the whole link, or ask an administrator for a new one.</p>
      )}
    </main>
  );
}
