/**
 * The guided tour (docs/AVATAR_SPEC.md section 3). Fixed, reviewed lines: nothing here is
 * generated at runtime. English is the spec's text word for word; Hindi is a faithful written
 * translation (same amounts, same meaning, nothing added). Pure data, tested in tour.test.ts.
 *
 * Prices: Grid & Grain (bench-design-templates) is India $16 and US $39 in its approved table.
 * If those prices change, update these lines.
 */

export const TOUR_LANGS = ["en", "hi"] as const;
export type TourLang = (typeof TOUR_LANGS)[number];

/** Page markers (data-assistant-highlight="…") the tour points at or clicks. */
export const TOUR_MARKERS = [
  "benchmark_tile",
  "price_box",
  "paypal_button",
  "password_field",
  "price_table",
  "formula_toggle",
  "step_audience",
  "step_prices",
  "step_publish",
  "step_orders",
] as const;
export type TourMarker = (typeof TOUR_MARKERS)[number];

export interface TourStep {
  id: string;
  /** Page to open first (path + query); omitted = stay on the current page. */
  path?: string;
  /** Markers to click, in order: only navigation inside a page (tabs, view toggles). */
  click?: TourMarker[];
  highlight?: TourMarker;
  line: Record<TourLang, string>;
  /** What to wait for after the line: a payment result, or the seller signing in. */
  wait?: "checkout_result" | "seller_signin";
  /** The visitor can skip it; the tour moves on by itself when they say "skip". */
  optional?: boolean;
  /** Only run this step when the seller is NOT signed in (T7). */
  onlyIfSignedOut?: boolean;
  /** Open Talk mode after this step (T8). */
  thenTalk?: boolean;
}

const PRODUCT = "/p/bench-design-templates";
const WORKSPACE = "/seller/products/bench-design-templates";

export const TOUR: readonly TourStep[] = [
  {
    id: "T1",
    path: "/",
    line: {
      en: "Hi! I'm the FairPrice guide. Digital products are usually priced for rich countries, so most of the world can't afford them. FairPrice gives every country a fair price, and PayPal checks the buyer's country before any money moves. Let me show you.",
      hi: "नमस्ते! मैं FairPrice का गाइड हूँ। डिजिटल प्रोडक्ट की कीमतें आमतौर पर अमीर देशों के हिसाब से रखी जाती हैं, इसलिए दुनिया के ज़्यादातर लोग उन्हें खरीद नहीं पाते। FairPrice हर देश को एक उचित कीमत देता है, और कोई भी पैसा लेने से पहले PayPal खरीदार के देश की जाँच करता है। आइए, मैं आपको दिखाता हूँ।",
    },
  },
  {
    id: "T2",
    path: "/benchmark?product=bench-us-tax-guide",
    highlight: "benchmark_tile",
    line: {
      en: "First, how prices are set. A simple formula discounts by income alone. Our AI also asks who actually buys the product. This guide is only useful to US taxpayers, so a formula would give deep discounts in 34 countries where buyers are unlikely. The AI gives none there.",
      hi: "पहले, कीमतें कैसे तय होती हैं। एक सीधा फ़ॉर्मूला सिर्फ़ आमदनी के हिसाब से छूट देता है। हमारा AI यह भी देखता है कि प्रोडक्ट असल में कौन खरीदता है। यह गाइड सिर्फ़ अमेरिका के टैक्स भरने वालों के काम की है, इसलिए फ़ॉर्मूला 34 ऐसे देशों में भारी छूट दे देता जहाँ खरीदार मिलने की संभावना कम है। AI वहाँ कोई छूट नहीं देता।",
    },
  },
  {
    id: "T3",
    path: `${PRODUCT}?as=IN`,
    highlight: "price_box",
    line: {
      en: "Now the buyer side. I'm simulating a visitor from India, as the banner says. This template pack is 39 dollars as standard, but the fair price for India is 16 dollars.",
      hi: "अब खरीदार की तरफ़। जैसा बैनर में लिखा है, मैं भारत से आए एक विज़िटर की नकल कर रहा हूँ। इस टेम्पलेट पैक की मानक कीमत 39 डॉलर है, लेकिन भारत के लिए उचित कीमत 16 डॉलर है।",
    },
  },
  {
    id: "T4",
    highlight: "paypal_button",
    wait: "checkout_result",
    optional: true,
    line: {
      en: "To see the real check, press the yellow PayPal button and log in with the India sandbox buyer. I'll wait, or say skip.",
      hi: "असली जाँच देखने के लिए, पीला PayPal बटन दबाएँ और India sandbox buyer से लॉग इन करें। मैं इंतज़ार करूँगा, या स्किप बोलें।",
    },
  },
  {
    id: "T5",
    wait: "checkout_result",
    optional: true,
    line: {
      en: "Now the problem every regional discount has: VPNs. Someone with a US PayPal account can pretend to be in India and see 16 dollars here. But FairPrice only reserves the money first. PayPal reports a US account, so the reservation is cancelled, nothing is charged, and they're offered the US price of 39 dollars. You can try it with the US sandbox buyer, or say skip.",
      hi: "अब वह समस्या जो हर क्षेत्रीय छूट के साथ आती है: VPN। अमेरिकी PayPal खाते वाला कोई व्यक्ति भारत में होने का दिखावा करके यहाँ 16 डॉलर देख सकता है। लेकिन FairPrice पहले सिर्फ़ पैसा रिज़र्व करता है। PayPal बताता है कि खाता अमेरिका का है, इसलिए रिज़र्वेशन रद्द हो जाता है, कोई पैसा नहीं लिया जाता, और उन्हें अमेरिका की कीमत 39 डॉलर ऑफ़र की जाती है। आप US sandbox buyer से इसे आज़मा सकते हैं, या स्किप बोलें।",
    },
  },
  {
    id: "T6",
    path: `${PRODUCT}?as=US`,
    highlight: "price_box",
    line: {
      en: "It's fair both ways. Here the visitor looks like they're in the US, so the page shows 39 dollars. If their PayPal account is Indian, FairPrice charges only the Indian price of 16 dollars. A traveler is never overcharged.",
      hi: "यह दोनों तरफ़ से उचित है। यहाँ विज़िटर अमेरिका में लगता है, इसलिए पेज 39 डॉलर दिखाता है। अगर उनका PayPal खाता भारत का है, तो FairPrice सिर्फ़ भारत की कीमत 16 डॉलर ही लेता है। यात्रा करने वाले से कभी ज़्यादा पैसा नहीं लिया जाता।",
    },
  },
  {
    id: "T7",
    path: "/seller",
    highlight: "password_field",
    wait: "seller_signin",
    optional: true,
    onlyIfSignedOut: true,
    line: {
      en: "Now the seller side. Sellers sign in with a password; for this demo it's in our Devpost notes. Please type it yourself. I'll wait, or say skip.",
      hi: "अब विक्रेता की तरफ़। विक्रेता पासवर्ड से साइन इन करते हैं; इस डेमो के लिए वह हमारे Devpost नोट्स में है। कृपया उसे खुद टाइप करें। मैं इंतज़ार करूँगा, या स्किप बोलें।",
    },
  },
  {
    id: "T7a",
    path: WORKSPACE,
    click: ["step_audience"],
    line: {
      en: "For each product, the AI first works out who buys it, region by region.",
      hi: "हर प्रोडक्ट के लिए, AI पहले यह पता लगाता है कि उसे कौन खरीदता है, इलाके के हिसाब से।",
    },
  },
  {
    id: "T7b",
    click: ["step_prices", "formula_toggle"],
    highlight: "price_table",
    line: {
      en: "Then it proposes a price for each of 42 countries, with a one-line reason. Code checks every price against the seller's limits, and the seller can compare with the formula and edit anything.",
      hi: "फिर वह 42 देशों में से हर एक के लिए कीमत सुझाता है, एक लाइन की वजह के साथ। कोड हर कीमत को विक्रेता की सीमाओं के हिसाब से जाँचता है, और विक्रेता फ़ॉर्मूले से तुलना करके कुछ भी बदल सकता है।",
    },
  },
  {
    id: "T7c",
    click: ["step_publish"],
    line: {
      en: "Nothing is sold until the seller approves. Approved prices are locked with a version and a fingerprint.",
      hi: "जब तक विक्रेता मंज़ूरी नहीं देता, कुछ भी नहीं बिकता। मंज़ूर की गई कीमतें एक वर्ज़न और एक फ़िंगरप्रिंट के साथ लॉक हो जाती हैं।",
    },
  },
  {
    id: "T7d",
    click: ["step_orders"],
    line: {
      en: "And every order is recorded: the decision, and the real PayPal order, authorization and capture IDs.",
      hi: "और हर ऑर्डर दर्ज होता है: फ़ैसला, और PayPal के असली ऑर्डर, ऑथराइज़ेशन और कैप्चर IDs।",
    },
  },
  {
    id: "T8",
    thenTalk: true,
    line: {
      en: "That's FairPrice: AI that prices by real audience, and PayPal as the trust check, so buyers pay fairly and sellers aren't gamed. Want to try? Ask me to find a product, or to help you sell one, in your own language.",
      hi: "यही है FairPrice: AI जो असली खरीदारों के हिसाब से कीमत तय करता है, और PayPal भरोसे की जाँच के रूप में, ताकि खरीदार उचित कीमत दें और विक्रेताओं के साथ धोखा न हो। आज़माना चाहेंगे? मुझसे कोई प्रोडक्ट ढूँढने को कहें, या अपना प्रोडक्ट बेचने में मदद माँगें, अपनी भाषा में।",
    },
  },
];

/** Words that skip the current step or stop the tour, in each tour language. */
export type TourCommand = "skip" | "stop" | "pause" | "resume";

export const TOUR_COMMANDS: Record<TourCommand, readonly string[]> = {
  skip: ["skip", "next", "स्किप", "छोड़ो", "छोड़ें", "आगे"],
  stop: ["stop", "end tour", "रुको", "रुकें", "बंद करो", "बंद करें"],
  pause: ["pause", "wait", "hold on", "one moment", "रुकिए", "एक मिनट", "ज़रा रुको", "पॉज़"],
  resume: ["continue", "resume", "go on", "carry on", "go ahead", "जारी रखो", "जारी रखें", "चलो", "आगे बढ़ो", "आगे बढ़िए", "शुरू करो"],
};

/** "skip", "stop", "pause", "resume" or null for something the visitor said (stop wins, then pause, then resume). */
export function tourCommand(heard: string): TourCommand | null {
  const h = heard.toLowerCase();
  if (TOUR_COMMANDS.stop.some((w) => h.includes(w))) return "stop";
  if (TOUR_COMMANDS.pause.some((w) => h.includes(w))) return "pause";
  if (TOUR_COMMANDS.resume.some((w) => h.includes(w))) return "resume"; // before skip: "आगे बढ़ो" is "go on"
  if (TOUR_COMMANDS.skip.some((w) => h.includes(w))) return "skip";
  return null;
}

/**
 * True when the visitor is asking for the guided tour ("walk me through the demo", "टूर दिखाओ"),
 * so the widget starts the tour instead of asking the assistant. Clear phrases only: a passing
 * mention of a "demo product" doesn't count.
 */
export function isTourRequest(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(tour|walk ?through|walk me through|show me around)\b/.test(t) ||
    /\b(give|show|run|start|see|watch)\b[^.?!]{0,20}\bdemo\b/.test(t) ||
    /\bdemo (please|tour)\b/.test(t) ||
    /टूर|डेमो/.test(t)
  );
}

/**
 * True when the line being spoken itself contains a word for this command ("…or say skip"):
 * the microphone may be hearing the guide, not the visitor, so the command is ignored.
 */
export function heardOwnLine(cmd: TourCommand, line: string | null): boolean {
  if (!line) return false;
  const l = line.toLowerCase();
  return TOUR_COMMANDS[cmd].some((w) => l.includes(w));
}

/**
 * A line split into its sentences, each keeping its own punctuation and trailing space (so joining
 * them gives the line back). Ends at . ! ? or the Hindi full stop । followed by a space or the end,
 * so "$24.50" stays whole.
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  const end = /[.!?।]+["'”’)\]]*(\s+|$)/g;
  let start = 0;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    out.push(text.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push(text.slice(start));
  return out.filter((s) => s.trim());
}

/**
 * What is left of a tour line when the visitor paused it after Alex had said `wordsSaid` words:
 * the line from the start of the sentence he was in (said again in full, since his transcript can
 * run a little ahead of what was heard). Nothing said yet: the whole line.
 */
export function restOfLine(line: string, wordsSaid: number): string {
  if (!(wordsSaid > 0)) return line;
  const parts = sentencesOf(line);
  let said = 0;
  for (let i = 0; i < parts.length; i++) {
    const n = parts[i].trim().split(/\s+/).filter(Boolean).length;
    if (said + n >= wordsSaid) return parts.slice(i).join("").trim();
    said += n;
  }
  return (parts[parts.length - 1] ?? line).trim();
}

/** Marker on the signed-in seller's product list (app/seller/page.tsx). */
export const SELLER_HOME_MARKER = "seller_home";

/**
 * Where opening /seller landed (T7): "signin" when the sign-in form shows, "in" when the seller's
 * product list shows, null while still loading. The address alone isn't enough: the browser shows
 * "/seller" for a moment before a signed-out visitor is redirected to /seller/sign-in.
 */
export function sellerArea(pathname: string, page: { passwordField: boolean; sellerHome: boolean }): "signin" | "in" | null {
  if (pathname === "/seller/sign-in" && page.passwordField) return "signin";
  if (pathname === "/seller" && page.sellerHome && !page.passwordField) return "in";
  return null;
}

export function tourLang(lang: string): TourLang {
  return lang === "hi" ? "hi" : "en";
}
