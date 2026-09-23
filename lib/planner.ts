// ════════════════════════════════════════════════════════════════════
// QUERY PLANNER — the "rewrite" step
//
// Search can't read a conversation. If a customer asks "Does the clear one
// fit a Club Car Onward?" and then "what about a 2018?", searching for
// "what about a 2018?" finds nothing useful. So before searching, a quick
// Claude call rewrites the latest message into a complete, standalone
// question ("Does the clear windshield fit a 2018 Club Car Onward?").
//
// The same call pulls out fitment details (make / model / year / SKU) as
// structured JSON, mapped onto the exact cart names in our fitment table,
// so the fitment lookup can be exact instead of fuzzy.
// ════════════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const PlanSchema = z.object({
  standalone_question: z
    .string()
    .describe("The user's latest message rewritten as a complete question that makes sense on its own."),
  fitment: z
    .object({
      make: z.string().nullable(),
      model: z.string().nullable(),
      year: z.number().int().nullable(),
      sku: z.string().nullable(),
    })
    .nullable()
    .describe("Only when the question is about which product fits a specific cart, or what a specific SKU fits. Otherwise null."),
  dealer_inquiry: z
    .boolean()
    .describe(
      "True if the message is about being or becoming a dealer, wholesaler, distributor, or reseller: dealer pricing, " +
        "discounts, margins, or minimum advertised price, dealer applications, dealer ordering, or dealer program terms. " +
        "False for ordinary customers asking about retail prices, shipping, or finding a local dealer to buy from.",
    ),
});

export type QueryPlan = z.infer<typeof PlanSchema> & { usage: { input: number; output: number } };

const PLANNER_SYSTEM = `You prepare customer questions for a document search system at a golf cart / LSV windshield company.

Given the conversation so far and the customer's latest message:
1. Rewrite the latest message as one standalone question, resolving references like "it", "that one", or "what about 2018?" using the conversation. Keep the customer's meaning; don't add facts or answer it.
2. If the question is about fitment (which windshield fits a cart, or what a SKU fits), fill in the fitment fields:
   - make/model: when the customer's cart matches one in the KNOWN CARTS list (even if abbreviated or misspelled, e.g. "CC Precedent" → "Club Car" / "Precedent"), copy the make and model spelling from that list exactly. If it doesn't match anything in the list, use the customer's own words — never substitute a different cart.
   - year: a 4-digit model year if the customer gave one, else null.
   - sku: a product SKU if the customer mentioned one, else null.
   Otherwise set fitment to null.
3. Set dealer_inquiry to true if the message is from or about a dealer/wholesaler/reseller relationship: dealer pricing or discounts, becoming a dealer, placing dealer or bulk-for-resale orders, or dealer program terms. Ordinary retail questions (prices, shipping, returns) are not dealer inquiries.`;

export async function planQuery(
  client: Anthropic,
  question: string,
  history: ChatTurn[],
  knownCarts: string[],
): Promise<QueryPlan> {
  const convo = history
    .slice(-6)
    .map((t) => `${t.role === "user" ? "Customer" : "Assistant"}: ${t.content}`)
    .join("\n");

  const response = await client.messages.parse({
    model: config.claudeModel,
    max_tokens: 1024,
    system: PLANNER_SYSTEM,
    output_config: { format: zodOutputFormat(PlanSchema), effort: "low" },
    messages: [
      {
        role: "user",
        content:
          `KNOWN CARTS (make | model):\n${knownCarts.join("\n") || "(none loaded)"}\n\n` +
          `CONVERSATION SO FAR:\n${convo || "(none)"}\n\n` +
          `LATEST MESSAGE:\n${question}`,
      },
    ],
  });

  const usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };
  // If parsing failed (or the request was declined), fall back to searching the raw question.
  const parsed = response.parsed_output;
  if (!parsed) return { standalone_question: question, fitment: null, dealer_inquiry: false, usage };
  return { ...parsed, usage };
}
