import { describe, expect, it } from "vitest";
import { ASSISTANT_SYSTEM_PROMPT } from "@/lib/assistant/prompt";
import { ASSISTANT_TOOLS } from "@/lib/assistant/tools";
import { alexSystemInstruction, alexTools, toGeminiSchema } from "./gemini";

describe("Alex (Gemini brain)", () => {
  it("uses the same rules as the Claude assistant, word for word, plus the page context", () => {
    const s = alexSystemInstruction({ pathname: "/p/x", displayCountry: "IN", sellerSignedIn: false, lang: "en" });
    expect(s.startsWith(ASSISTANT_SYSTEM_PROMPT)).toBe(true);
    expect(s).toContain("Only state a price that a tool returned");
    expect(s).toContain("your name is Alex");
    expect(s).toContain("Current page: /p/x");
  });

  it("offers exactly the assistant's tools, plus start_tour, and never an approve or pay tool", () => {
    const names = alexTools().map((t) => t.name);
    expect(names).toEqual([...ASSISTANT_TOOLS.map((t) => t.name), "start_tour"]);
    expect(names.join(" ")).not.toMatch(/approve|pay|capture|refund|password/);
  });

  it("converts the tool schemas to Gemini's format", () => {
    expect(toGeminiSchema({ anyOf: [{ type: "number" }, { type: "null" }] })).toEqual({ type: "NUMBER", nullable: true });
    expect(toGeminiSchema({ anyOf: [{ type: "string", enum: ["reach", "revenue"] }, { type: "null" }] })).toEqual({
      type: "STRING",
      enum: ["reach", "revenue"],
      nullable: true,
    });
    const press = alexTools().find((t) => t.name === "press_button")!;
    expect(press.parameters).toMatchObject({ type: "OBJECT", required: ["button"], properties: { button: { type: "STRING" } } });
    expect(JSON.stringify(press.parameters)).not.toContain("approve");
    expect(alexTools().find((t) => t.name === "list_my_products")!.parameters).toBeUndefined();
  });
});
