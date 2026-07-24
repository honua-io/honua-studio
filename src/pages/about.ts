/** Static about view — proves the router stub renders a second route. */
export function renderAbout(root: HTMLElement): void {
  root.innerHTML = `
    <section class="hn-panel view-section" data-testid="about-section">
      <h2 class="hn-panel-title">About Honua Studio</h2>
      <p>
        Honua Studio is an open-source, model-agnostic builder for geospatial
        applications: describe the app you want in conversation, and an agent
        composes it through typed, bounded, auditable commands built on the
        Honua JS SDK.
      </p>
      <p class="hn-muted">
        Status: Phase 0 — app scaffold, CI, and design tokens
        (<a href="https://github.com/honua-io/honua-studio/issues/3">honua-studio#3</a>).
      </p>
    </section>
  `;
}
