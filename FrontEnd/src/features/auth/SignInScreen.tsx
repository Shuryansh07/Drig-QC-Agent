import { PageShell } from "@/components/common/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Skeleton. There is no auth service to sign into yet. */
export default function SignInScreen() {
  return (
    <PageShell
      dock={
        <Button disabled className="h-touch-lg w-full text-step">
          Sign in
        </Button>
      }
    >
      <h1 className="text-title font-semibold tracking-tight">DRIG Tech Support</h1>
      <p className="text-body text-muted-foreground mt-2 max-w-[38ch]">
        Sign in with your workshop account.
      </p>

      <div className="mt-8 space-y-4">
        <Input
          type="email"
          inputMode="email"
          autoComplete="username"
          placeholder="Work email"
          aria-label="Work email"
          className="text-body h-touch"
        />
        <Input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          aria-label="Password"
          className="text-body h-touch"
        />
      </div>
    </PageShell>
  );
}
