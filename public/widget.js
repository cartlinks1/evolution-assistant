/*
 * Evolution chat bubble. Add to the Shopify theme with one line:
 *   <script src="https://YOUR-APP.vercel.app/widget.js" defer></script>
 * It adds a floating "Ask us" button that opens the chat (/embed) in a panel.
 */
(function () {
  if (window.__evolutionChat) return;
  window.__evolutionChat = true;

  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  var NAVY = "#12304a", ORANGE = "#f7941d";

  var style = document.createElement("style");
  style.textContent =
    "#evo-chat-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;" +
    "padding:12px 18px;border:0;border-radius:999px;background:" + NAVY + ";color:#fff;font:600 15px/1 -apple-system,system-ui,sans-serif;" +
    "box-shadow:0 6px 24px rgba(18,48,74,.35);cursor:pointer}" +
    "#evo-chat-btn:hover{background:#1b4466}" +
    "#evo-chat-btn .dot{width:10px;height:10px;border-radius:50%;background:" + ORANGE + "}" +
    "#evo-chat-panel{position:fixed;right:20px;bottom:84px;z-index:2147483000;width:380px;height:600px;" +
    "max-height:calc(100vh - 110px);border-radius:16px;overflow:hidden;box-shadow:0 12px 48px rgba(18,48,74,.3);" +
    "background:#f4f7fa;display:none}" +
    "#evo-chat-panel.open{display:block}" +
    "#evo-chat-panel iframe{width:100%;height:100%;border:0}" +
    "@media (max-width:520px){#evo-chat-panel{right:0;bottom:0;width:100vw;height:100vh;max-height:none;border-radius:0}" +
    "#evo-chat-panel.open+#evo-chat-btn{display:none}}";
  document.head.appendChild(style);

  var panel = document.createElement("div");
  panel.id = "evo-chat-panel";
  var button = document.createElement("button");
  button.id = "evo-chat-btn";
  button.type = "button";
  button.setAttribute("aria-label", "Ask Evolution a question");
  button.innerHTML = '<span class="dot"></span><span>Ask us</span>';
  document.body.appendChild(panel);
  document.body.appendChild(button);

  var loaded = false;
  function open() {
    if (!loaded) {
      var frame = document.createElement("iframe");
      frame.src = origin + "/embed";
      frame.title = "Evolution Windshields assistant";
      panel.appendChild(frame);
      loaded = true;
    }
    panel.classList.add("open");
    button.setAttribute("aria-expanded", "true");
  }
  function close() {
    panel.classList.remove("open");
    button.setAttribute("aria-expanded", "false");
  }
  button.addEventListener("click", function () {
    panel.classList.contains("open") ? close() : open();
  });
  window.addEventListener("message", function (e) {
    if (e.origin === origin && e.data === "evo-chat-close") close();
  });
})();
