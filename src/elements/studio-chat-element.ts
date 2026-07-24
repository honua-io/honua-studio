/**
 * `<honua-studio-chat>` — placeholder chat console surface (honua-studio#5;
 * the real streaming/tool-call/activity-log console is honua-studio#6).
 * Phase 0 scope: prove the element contract end to end (attributes, typed
 * events, session injection, cleanup) on a minimal composer + local log, so
 * #6 has a load-bearing shape to extend rather than starting from scratch.
 */
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedSession } from "./session.js";
import { baseElementStyles, chatStyles } from "./styles.js";
import type { HonuaStudioChatMessageDetail, HonuaStudioSessionAdapter } from "./types.js";

export class HonuaStudioChatElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label", "placeholder"];
  }

  #session: HonuaStudioSessionAdapter | undefined;
  #log: string[] = [];

  /** Direct session override — falls back to the nearest `<honua-studio-app>` ancestor when unset. See docs/embed-session.md. */
  public get session(): HonuaStudioSessionAdapter | undefined {
    return this.#session;
  }

  public set session(session: HonuaStudioSessionAdapter | undefined) {
    this.#session = session;
    this.render();
  }

  /** Messages submitted so far this connection — cleared on unmount (no persistence beyond the DOM's own lifetime, by design; #6 owns real history). */
  public get log(): readonly string[] {
    return this.#log;
  }

  public attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.render();
  }

  protected onConnect(): void {
    if (!this.#session) {
      const inherited = resolveInjectedSession(this);
      if (inherited) this.#session = inherited;
      else this.dispatchTypedEvent("honua-studio-session-required", { reason: "honua-studio-chat has no session" });
    }
  }

  protected onDisconnect(): void {
    this.#log = [];
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Chat";
    const placeholder = this.getAttribute("placeholder") ?? "Describe the app you want…";
    const sessionStatus = this.#session?.getSnapshot().status ?? "anonymous";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${chatStyles()}</style>
      <section class="chat hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="studio-chat">
        <div>
          <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
          <p class="hn-register" data-testid="studio-chat-session-status">${escapeHtml(sessionStatus)}</p>
        </div>
        <ul class="chat-log" aria-live="polite" data-testid="studio-chat-log">
          ${
            this.#log.length === 0
              ? `<li class="hn-muted">No messages yet.</li>`
              : this.#log.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
          }
        </ul>
        <form data-testid="studio-chat-form">
          <label class="hn-muted" for="honua-studio-chat-input" style="position:absolute;width:1px;height:1px;overflow:hidden;">${escapeHtml(label)}</label>
          <input id="honua-studio-chat-input" type="text" placeholder="${escapeHtml(placeholder)}" data-testid="studio-chat-input" autocomplete="off" />
          <button type="submit" class="hn-btn hn-btn--sm" data-testid="studio-chat-send">Send</button>
        </form>
      </section>
    `);
    this.shadowRoot?.querySelector("form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const input = this.shadowRoot?.querySelector<HTMLInputElement>("#honua-studio-chat-input");
        const text = input?.value.trim();
        if (!input || !text) return;
        this.#log = [...this.#log, text];
        input.value = "";
        this.render();
        this.dispatchTypedEvent<HonuaStudioChatMessageDetail>("honua-studio-chat-message", { text });
      },
      { signal: this.connectedSignal },
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
