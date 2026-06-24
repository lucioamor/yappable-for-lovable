// Shared reader for Lovable's floating background-task widget.
(function (root) {
  "use strict";

  function clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function read(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return null;
    const status = Array.from(doc.querySelectorAll('[role="status"][aria-live]'))
      .find((el) => /background task/i.test(el.textContent || ""));
    if (!status) return null;

    const scope = status.parentElement || status;
    const buttons = Array.from(scope.querySelectorAll("li button"));
    const button = buttons[buttons.length - 1];
    if (!button) return null;

    const muted = button.querySelector("span.text-muted-foreground");
    const desc = muted ? clean(muted.textContent).replace(/^[\s:]+/, "") : "";
    const wrapper = muted ? muted.parentElement : button.querySelector("span.truncate");
    let title = "";
    if (wrapper) {
      const clone = wrapper.cloneNode(true);
      clone.querySelectorAll("span.text-muted-foreground").forEach((el) => el.remove());
      title = clean(clone.textContent);
    }

    return (title || desc) ? { title, desc } : null;
  }

  const api = { read, clean };
  root.LovableTaskWidget = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
