// ════════════════════════════════════════════════════════════════════
// DEALER QUESTIONS — always "please email us"
//
// Company policy: everything dealer-related (pricing, becoming a dealer,
// dealer ordering, program terms) is handled personally by email. There is
// no dealer login and no dealer-only content. Enforced in four places:
//
//   1. PLANNER    flags dealer questions → fixed reply with the email,
//                 before any search or answer is generated (answer.ts)
//   2. PROMPT     tells Claude never to state dealer pricing or terms (prompt.ts)
//   3. OUTPUT     this guard strips any sentence that pairs money with
//                 dealer/wholesale wording, in case one slips through
//   4. INGEST     refuses a dealer/ folder, and warns when a document talks
//                 about dealer pricing (scripts/ingest.ts)
//
// Normal retail prices ("expedited shipping is $49") are unaffected.
// ════════════════════════════════════════════════════════════════════

import { filterSentences, type CitedSegment, type SentenceCheck } from "./claims";
import { config } from "./config";

/** Money: "$219", "219 dollars", "35% off", "a 10% discount", "Net 30". */
export const MONEY_PATTERN = /\$\s?\d|\b\d[\d,.]*\s?(dollars|usd)\b|\b\d+\s?%\s?(off|discount)\b|\bdiscount\w*\b|\bnet\s?\d+\b/i;

/** Wording that makes a price a dealer price. */
export const DEALER_WORDS =
  /\b(dealers?|dealerships?|wholesale|distributors?|resellers?|pricing tiers?|price tiers?|tiered|margins?|minimum advertised|net price)\b/i;

export const dealerReply = () =>
  `For dealer questions, including pricing, becoming a dealer, and placing dealer orders, ` +
  `please email ${config.contact.email} and our team will take care of you directly.`;

const checkDealerPricing: SentenceCheck = (sentence) =>
  MONEY_PATTERN.test(sentence) && DEALER_WORDS.test(sentence) ? "dealer/wholesale pricing" : null;

export const guardDealerPricing = (segments: CitedSegment[]) => filterSentences(segments, checkDealerPricing);
