import type { WorkItem } from "@orion/core";
import { readMissionControl } from "../lib/orion";
import { actOnWorkItem } from "./actions";

export const dynamic = "force-dynamic";

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Only http(s) links are safe to render as navigable anchors. Source-provided
 * URLs are otherwise untrusted (a future Skill could supply `javascript:` or
 * `data:`), so anything else is shown as plain text rather than a link.
 */
function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "https:" || scheme === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function ActionButtons({ item }: { item: WorkItem }) {
  return (
    <div className="actions">
      {(["acted", "snoozed", "dismissed"] as const).map((action) => (
        <form action={actOnWorkItem} key={action}>
          <input type="hidden" name="workItemId" value={item.id} />
          <input type="hidden" name="action" value={action} />
          <input type="hidden" name="revision" value={item.attentionRevision} />
          <button type="submit" className={`action action--${action}`}>
            {action === "acted" ? "Handled" : action === "snoozed" ? "Later" : "Not now"}
          </button>
        </form>
      ))}
    </div>
  );
}

function Card({ item, muted }: { item: WorkItem; muted?: boolean }) {
  const href = safeHref(item.url);
  return (
    <article className={`card${muted ? " card--muted" : ""}`}>
      <h3 className="card__title">{item.title}</h3>
      {item.location ? (
        <p className="card__location">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer">
              {item.location}
            </a>
          ) : (
            item.location
          )}
        </p>
      ) : null}
      <p className="card__reason">{item.reason}</p>

      {item.summary ? (
        <p className="card__summary">
          {item.summary}
          <span className="card__advisory"> · AI summary</span>
        </p>
      ) : null}

      <details className="why">
        <summary>Why is this here?</summary>
        <ul>
          {item.evidence.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
        <p className="why__trace">
          Traces to {item.createdFromEventIds.length} event(s). Opportunity{" "}
          {item.opportunity.toFixed(2)} · Urgency {item.urgency.toFixed(2)} · Commitment{" "}
          {item.commitment.toFixed(2)} · Capacity {item.capacity.toFixed(2)}.
        </p>
      </details>

      <ActionButtons item={item} />
    </article>
  );
}

export default async function Page() {
  const view = await readMissionControl();
  const now = new Date(view.generatedAt);

  return (
    <main className="shell">
      <header className="masthead">
        <p className="masthead__eyebrow">Mission Control</p>
        <h1 className="masthead__title">{greeting(now)}.</h1>
        <p className="masthead__subtitle">
          {view.needsAttention.length === 0
            ? "Nothing needs you right now. You're clear."
            : `${view.needsAttention.length} thing${
                view.needsAttention.length === 1 ? "" : "s"
              } deserve your attention. Everything else can wait.`}
        </p>
      </header>

      {view.needsAttention.length > 0 ? (
        <section className="section">
          <h2 className="section__label">Needs attention</h2>
          {view.needsAttention.map((item) => (
            <Card key={item.id} item={item} />
          ))}
        </section>
      ) : (
        <section className="section section--calm">
          <p>Orion has looked. Nothing else needs you. Enjoy the quiet.</p>
        </section>
      )}

      {view.canWait.length > 0 ? (
        <section className="section">
          <h2 className="section__label section__label--muted">Can wait</h2>
          {view.canWait.map((item) => (
            <Card key={item.id} item={item} muted />
          ))}
        </section>
      ) : null}

      <footer className="footer">
        <span>
          Ranked deterministically · explanations are AI-free · summaries via {view.providerName}
        </span>
      </footer>
    </main>
  );
}
