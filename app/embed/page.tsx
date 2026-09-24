import Chat from "../components/Chat";
import { config } from "@/lib/config";

// The chat as it appears inside the bubble on evolutionwindshields.com (loaded in an iframe by /widget.js).
export default function Embed() {
  return <Chat embedded contactEmail={config.contact.email} />;
}
