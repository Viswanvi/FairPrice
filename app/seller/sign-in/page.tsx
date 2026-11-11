import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentSellerId } from "@/lib/auth/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Seller sign-in · FairPrice" };

export default async function SignInPage() {
  if (await currentSellerId()) redirect("/seller");
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 pt-8 sm:pt-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to your seller account</h1>
        <p className="text-sm text-ink-2">Set fair prices per country, approve them, and see every order PayPal verified.</p>
      </div>
      <SignInForm />
    </div>
  );
}
