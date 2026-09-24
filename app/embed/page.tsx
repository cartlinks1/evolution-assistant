import Chat from "../components/Chat";
import { config } from "@/lib/config";

// Rendered per visit (not at build time) so the contact details come from the live settings.
export const dynamic = "force-dynamic";

// The chat as it appears inside the bubble on evolutionwindshields.com (loaded in an iframe by /widget.js).
export default function Embed() {
  return <Chat embedded contactEmail={config.contact.email} />;
}
