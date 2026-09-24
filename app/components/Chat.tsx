"use client";

// The chat window. Used full-page (/) and inside the website bubble (/embed).
// Conversation history lives only in this browser tab's memory — nothing is
// saved on the visitor's device, and a refresh starts a new conversation.

import { useEffect, useRef, useState, type ReactNode } from "react";

interface Source {
  n: number;
  title: string;
  section: string | null;
  quote: string | null;
}
interface Message {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
}

const STARTERS = [
  "Which windshield fits my cart?",
  "Does it block UV?",
  "Is it street legal?",
  "What's your return policy?",
];

/** Minimal formatting for answers: **bold**, "- " bullet lines, and [n] citation chips. */
function renderInline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[\d+\])/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong>;
    if (/^\[\d+\]$/.test(part)) return <sup key={`${key}-${i}`} className="cite">{part.slice(1, -1)}</sup>;
    return part;
  });
}

function Formatted({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, b) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
          return (
            <ul key={b}>
              {lines.map((l, i) => (
                <li key={i}>{renderInline(l.replace(/^\s*[-•]\s+/, ""), `${b}-${i}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={b}>{lines.flatMap((l, i) => (i ? [<br key={`br-${i}`} />, ...renderInline(l, `${b}-${i}`)] : renderInline(l, `${b}-${i}`)))}</p>;
      })}
    </>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!sources.length) return null;
  return (
    <div className="sources">
      <div className="sources-label">Sources</div>
      {sources.map((s) => (
        <div key={s.n} className="source">
          <button className="source-title" onClick={() => setOpen(open === s.n ? null : s.n)} aria-expanded={open === s.n}>
            <span className="cite">{s.n}</span> {s.title}
            {s.section && !s.section.startsWith(s.title) ? <span className="source-section"> · {s.section}</span> : null}
          </button>
          {open === s.n && s.quote ? <blockquote>“{s.quote}”</blockquote> : null}
        </div>
      ))}
    </div>
  );
}

export default function Chat({ embedded = false, contactEmail }: { embedded?: boolean; contactEmail: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now())));
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history, sessionId }),
      });
      const data = (await res.json()) as { text?: string; sources?: Source[] };
      setMessages((m) => [...m, { role: "assistant", text: data.text ?? `Sorry, something went wrong. Please email ${contactEmail}.`, sources: data.sources ?? [] }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: `Sorry, I couldn't connect. Please email ${contactEmail}.` }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className={`chat ${embedded ? "embedded" : ""}`}>
      <header className="chat-header">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-shield.png" alt="" width={36} height={36} />
        <div>
          <div className="brand">EVOLUTION <span>WINDSHIELDS</span></div>
          <div className="tagline">Ask about fitment, features &amp; policies</div>
        </div>
        {embedded ? (
          <button className="close" aria-label="Close chat" onClick={() => window.parent.postMessage("evo-chat-close", "*")}>
            ×
          </button>
        ) : null}
      </header>

      <div className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="welcome">
            <p>Hi! I can answer questions about Evolution windshields: which one fits your cart, UV protection, airflow, street-legal status, and our policies.</p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.role === "assistant" ? <Formatted text={m.text} /> : m.text}</div>
            {m.role === "assistant" && m.sources ? <Sources sources={m.sources} /> : null}
          </div>
        ))}
        {busy ? (
          <div className="msg assistant">
            <div className="bubble typing" aria-label="Assistant is typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          placeholder="Type your question…"
          rows={1}
          maxLength={500}
          aria-label="Your question"
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send">
          ➤
        </button>
      </form>
      <div className="fineprint">
        Answers come from Evolution&apos;s product documents. Anything else: <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
      </div>
    </div>
  );
}
