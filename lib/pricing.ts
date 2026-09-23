// ════════════════════════════════════════════════════════════════════
// DEALER PRICING — never answered by the assistant
//
// Company policy: dealer / wholesale pricing is handled personally, by email.
// The assistant must never state it — not to customers, not to logged-in
// dealers. Enforced in four places:
//
//   1. PLANNER    flags dealer-pricing questions → fixed reply with the email,
//                 before any search or answer is generated (answer.ts)
//   2. PROMPT     tells Claude never to state dealer pricing (prompt.ts)
//   3. OUTPUT     this guard strips any money sentence that cites a dealer
//                 document or talks about dealer/wholesale/tier pricing
//   4. INGEST     warns when a dealer document contains dollar amounts, so
//                 pricing can be removed from the source (scripts/ingest.ts)
//
// Normal retail prices from public documents ("expedited shipping is $49")
// are unaffected.
// ════════════════════════════════════════════════════════════════════

import { filterSentences, type CitedSegment, type SentenceCheck } from "./claims";
import { config } from "./config";

/** Money: "$219", "219 dollars", "35% off", "a 10% discount", "Net 30". */
export const MONEY_PATTERN = /\$\s?\d|\b\d[\d,.]*\s?(dollars|usd)\b|\b\d+\s?%\s?(off|discount)\b|\bdiscount\w*\b|\bnet\s?\d+\b/i;

/** Wording that makes a price a dealer price, even when cited from a public document. */
export const DEALER_PRICE_WORDS =
  /\b(dealers?|wholesale|distributors?|resellers?|pricing tiers?|price tiers?|tiered|margins?|minimum advertised|net price)\b/i;

export const dealerPricingReply = () =>
  `Dealer pricing isn't something I can share here. Please email ${config.contact.email} and our team will get it to you directly.`;

const checkDealerPricing: SentenceCheck = (sentence, citations) => {
  if (!MONEY_PATTERN.test(sentence)) return null;
  if (citations.some((c) => c.audience === "dealer")) return "pricing from a dealer document";
  if (DEALER_PRICE_WORDS.test(sentence)) return "dealer/wholesale pricing wording";
  return null;
};

export const guardDealerPricing = (segments: CitedSegment[]) => filterSentences(segments, checkDealerPricing);
