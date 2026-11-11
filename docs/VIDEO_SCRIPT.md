# Demo video — script (target 2:50, hard limit under 3:00)

One story: a creator, a buyer in India, a VPN user and a traveler, all on the real PayPal
sandbox. Record each scene separately and join them in editing. Cut the waiting (AI steps,
PayPal loading) so every scene stays inside its time.

**Product used:** *Full-Stack JavaScript Bootcamp* (`/p/demo-bootcamp`, base price $99).
After the seller approves its prices (scene 4), write down the India price and the US price.
Fill them into the `[India $]` / `[US $]` placeholders before recording the voiceover.

**If you already approved a table while rehearsing:** in scenes 3–4, press **Generate new
version**, then **Approve version 2** on camera. The buyer scenes then use version 2's prices.

---

## Before you record (checklist)

- [ ] **Wake the site.** Open https://fairprice-edof.onrender.com a minute before recording; the
      free plan sleeps when idle.
- [ ] **Rehearse every scene once:** fair price, VPN and traveler. The traveler hasn't been run on
      the live site yet, so rehearse it.
- [ ] **Use Incognito windows** for buyer scenes, and close them all between buyers, so PayPal
      forgets the last login.
- [ ] **Show a phone view** in buyer scenes: Chrome DevTools → device toolbar → a phone such as
      Pixel 7, or record on a real phone.
- [ ] **Nothing secret on screen:** no `.env`, no Render environment page, no API keys. Passwords
      appear only as dots.
- [ ] **Hide notifications,** and zoom the browser to 110–125% so text is readable.
- [ ] **Have the sandbox buyer logins ready** for India and the US.

---

## Scenes

| Time | Scene | On screen (what to click) | Voiceover |
| --- | --- | --- | --- |
| 0:00–0:20 | **The problem** | Title card, then the bootcamp's product page showing **$99**. | "Digital products are priced for rich countries. A ninety-nine-dollar course is out of reach for most learners in India or Brazil, and creators lose those sales." |
| 0:20–0:40 | **Seller setup** | `/seller` → sign in → open *Full-Stack JavaScript Bootcamp* → **Analyze audience**. Cut the wait; show the region chips and reasons. | "FairPrice reads the product and works out who actually buys it: individual learners, strongest in South Asia and Latin America." *(match what the AI actually says)* |
| 0:40–1:00 | **AI versus formula** | **Generate fair prices** (cut the wait) → toggle **Formula vs AI** → point at the highlighted rows. Then cut to `/benchmark` → **US tax guide**. | "A formula discounts everything. The AI discounts where real buyers are. A US tax guide stays near full price abroad; a coding course gets a deep discount in India." |
| 1:00–1:10 | **Approve** | **Approve version 1** → *Your product page is live* card with version and fingerprint. | "The seller approves. Prices are locked, versioned and fingerprinted. AI never touches checkout without that approval." |
| 1:10–1:40 | **Fair purchase (India)** | Phone view, Incognito: `/p/demo-bootcamp?as=IN` (banner: simulating India). Show **[India $]**, press **सुनें (Listen)** for 3 seconds of Hindi, then **Pay with PayPal** → log in as the **India** buyer → **Complete Purchase** → *Payment complete*. | "A buyer in India sees a fair price, with the explanation in Hindi, and pays with PayPal. Before any money moves, PayPal confirms the account is Indian." |
| 1:40–2:05 | **VPN caught** | New Incognito window, same `?as=IN` link → pay as the **US** buyer → result: *A different price applies… You have not been charged.* with the offer to pay [US $]. | "Now a US buyer pretends to be in India. PayPal reports a US account, so FairPrice cancels the payment. Nobody is charged a wrong amount, and the buyer is offered the right price." |
| 2:05–2:20 | **Traveler** | New Incognito window: `/p/demo-bootcamp?as=US` shows **[US $]** → pay as the **India** buyer → *You were charged [India $], the fair price for your country, not [US $].* | "It works both ways. An Indian buyer travelling in the US approves [US $], but is charged only [India $]." |
| 2:20–2:35 | **Trust** | `/seller` → the bootcamp → **Orders** tab: three orders with decisions *Match / Country mismatch / Traveler*, the PayPal order, authorization and capture IDs, and the table version. | "Every decision is recorded with its PayPal IDs and the exact price version it used." |
| 2:35–2:50 | **Vision** | Title card: *FairPrice — fair prices, verified by PayPal*, plus the live link and the GitHub link. Optional: one line about the voice assistant. | "PayPal's verified accounts can become the trust layer for fair global pricing, and a reason for millions of priced-out buyers to join PayPal. Next: a voice assistant that helps people buy and sell in their own language." |

---

## Tips

- **Speak slowly and calmly.** About 130 words per minute fits this script.
- **Keep the demo banner visible** in the buyer scenes: it shows honestly that `?as=` simulates
  the visitor's location.
- **Show real data, and say so.** Use the real PayPal sandbox window, not a mock; the IDs in the
  Orders tab are real sandbox IDs.
- **Upload settings:** YouTube, **Public** (not Unlisted). Title idea: *FairPrice — fair prices
  for every country, verified by PayPal (PayPal AI Hackathon 2026)*.
- **Afterwards:** put the video link in `docs/DEVPOST.md` and in the README.
