// The chatbot inside the job page: the chatbot buttons open it in a panel instead of leaving the page.
// The panel loads the same link the buttons point at (job.js sets it, with the job's car and equipment),
// so the chatbot needs no changes. "Open in new tab" stays as the way out.

const panel = document.getElementById("chat-panel");
const frame = document.getElementById("chat-frame");
const newTab = document.getElementById("chat-newtab");
let opener = null;

const openChat = (href, trigger) => {
  // Loaded once, on first open: an iframe that is never opened costs nothing, and reopening keeps the chat.
  if (!frame.src) frame.src = href;
  newTab.href = href;
  opener = trigger;
  panel.hidden = false;
  document.body.classList.add("chat-open");
  document.getElementById("chat-close").focus();
};

const closeChat = () => {
  panel.hidden = true;
  document.body.classList.remove("chat-open");
  opener?.focus();
};

for (const link of document.querySelectorAll("#chatbot-link, #chatbot-link-help")) {
  link.addEventListener("click", (event) => {
    // Ctrl/Cmd/middle-click still opens a real tab, as a link should.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    openChat(link.href, link);
  });
}

document.getElementById("chat-close").addEventListener("click", closeChat);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !panel.hidden) closeChat();
});
