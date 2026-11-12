import type { useRouter } from "next/navigation";
import type { ClientAction } from "@/lib/assistant/schema";
import { FILL_PRODUCT_FORM_EVENT } from "./events";

/**
 * Carry out the assistant's page actions in the browser. Only these four kinds exist (see
 * lib/assistant/schema.ts). Buttons are found by data-assistant markers that pages opt into;
 * Approve has only a highlight marker, so it can never be pressed from here.
 */

type Router = ReturnType<typeof useRouter>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(get: () => T | null, timeoutMs: number): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(100);
  }
}

export function highlight(el: HTMLElement): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("assistant-highlight");
  setTimeout(() => el.classList.remove("assistant-highlight"), 4500);
}

/** Runs the actions in order. Returns the targets that couldn't be done (e.g. a disabled button). */
export async function performActions(actions: ClientAction[], router: Router): Promise<string[]> {
  const problems: string[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "navigate": {
        const target = new URL(action.path, window.location.origin);
        if (target.origin !== window.location.origin) break; // same-site paths only
        if (window.location.pathname + window.location.search !== target.pathname + target.search) {
          router.push(target.pathname + target.search);
          await waitFor(() => (window.location.pathname === target.pathname ? true : null), 8000);
        }
        break;
      }
      case "fill_product_form": {
        const form = await waitFor(() => document.querySelector('[data-assistant-form="product"]'), 8000);
        if (!form) {
          problems.push("product_form");
          break;
        }
        await sleep(50); // let the form's listener attach after navigation
        window.dispatchEvent(new CustomEvent(FILL_PRODUCT_FORM_EVENT, { detail: action.fields }));
        highlight(form as HTMLElement);
        break;
      }
      case "press": {
        const button = await waitFor(() => {
          const el = document.querySelector<HTMLButtonElement>(`[data-assistant="${action.target}"]`);
          return el && !el.disabled ? el : null;
        }, 8000);
        if (!button) {
          problems.push(action.target);
          break;
        }
        highlight(button);
        button.click();
        break;
      }
      case "highlight": {
        const el = await waitFor(() => document.querySelector<HTMLElement>(`[data-assistant-highlight="${action.target}"]`), 8000);
        if (el) {
          highlight(el);
          if (action.target === "password_field" && el instanceof HTMLInputElement) el.focus({ preventScroll: true });
        }
        break;
      }
    }
  }
  return problems;
}
