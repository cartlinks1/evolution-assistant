import Chat from "./components/Chat";
import { config } from "@/lib/config";

// Full-page chat (also handy for testing). The website bubble loads /embed instead.
export default function Home() {
  return (
    <main className="page">
      <Chat contactEmail={config.contact.email} />
    </main>
  );
}
