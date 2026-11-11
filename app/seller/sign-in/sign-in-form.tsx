"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, ErrorNote, Field, inputClass } from "../../_components/ui";

export function SignInForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await fetch("/api/session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password }),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => null)) as { message?: string } | null;
              setError(body?.message ?? "Sign-in failed. Please try again.");
              return;
            }
            router.push("/seller");
            router.refresh();
          } catch {
            setError("We couldn't reach the server. Check your connection and try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Password" htmlFor="password" hint="The demo seller password from the project's .env file.">
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" loading={busy}>
          Sign in
        </Button>
      </form>
    </Card>
  );
}
