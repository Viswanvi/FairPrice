"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../_components/ui";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      className="h-8 px-3"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
        router.push("/seller/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
