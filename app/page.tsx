import Chat from "./components/Chat";
import { config } from "@/lib/config";

// Rendered per visit (not at build time) so the contact details come from the live settings.
export const dynamic = "force-dynamic";

// Full-page chat (also handy for testing). The website bubble loads /embed instead.
export default function Home() {
  return (
    <main className="page">
      <Chat contactEmail={config.contact.email} />
    </main>
  );
}
