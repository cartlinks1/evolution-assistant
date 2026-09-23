// ════════════════════════════════════════════════════════════════════
// CONTACT DETAILS — one email and one phone number, always
//
// Source documents don't all agree on contact details (older policies list
// other addresses). The owner's rule is that customers are always sent to
// CONTACT_EMAIL / CONTACT_PHONE. So after an answer is written, any other
// email address or US phone number in it is replaced with the configured one.
// ════════════════════════════════════════════════════════════════════

import { config } from "./config";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** US phone numbers: 434-249-3672, (434) 249-3672, 434.249.3672, 4342493672, +1 434 249 3672. */
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

export function normalizeContacts(text: string): string {
  const { email, phone } = config.contact;
  return text
    .replace(EMAIL, (found) => (found.toLowerCase() === email.toLowerCase() ? found : email))
    .replace(PHONE, (found) => (digits(found) === digits(phone) ? found : phone));
}
