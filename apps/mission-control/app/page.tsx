import type { WorkItem } from "@orion/core";
import type { GmailIntegrationState } from "@orion/gmail-auth";
import { readMissionControl, type MissionControlView } from "../lib/orion";
import { actOnWorkItem, suppressOriginatorAction, unsuppressOriginatorAction } from "./actions";

export const dynamic = "force-dynamic";

const CALLBACK_MESSAGES: Record<string, string> = {
  connected: "Gmail connected.",
  denied: "Gmail connection was cancelled.",
  account_mismatch: "That Google account does not match the configured Gmail account.",
  state_mismatch: "The security check failed. Please try connecting again.",
  rejected: "Authorization was incomplete (missing refresh token or gmail.readonly).",
  not_configured: "Gmail live mode is not configured.",
  error: "Something went wrong connecting Gmail.",
};

function GmailStatus({ state, sync }: { state: GmailIntegrationState; sync: MissionControlView["gmailSync"] }) {
  if (state.mode === "fixture") {
    return (
      <div className="gmail gmail--fixture">
        <span className="gmail__dot" aria-hidden />
        <span className="gmail__label">Reading fixture inbox (development)</span>
      </div>
    );
  }

  if (state.auth === "misconfigured") {
    return (
      <div className="gmail gmail--warn">
        <span className="gmail__dot" aria-hidden />
        <div>
          <span className="gmail__label">Gmail live mode is misconfigured</span>
          <ul className="gmail__issues">
            {state.issues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (state.auth === "disconnected") {
    return (
      <div className="gmail gmail--action">
        <span className="gmail__dot" aria-hidden />
        <span className="gmail__label">Gmail not connected</span>
        <a className="gmail__button" href="/api/gmail/connect">
          Connect Gmail
        </a>
      </div>
    );
  }

  if (state.auth === "reconnect_required") {
    return (
      <div className="gmail gmail--warn">
        <span className="gmail__dot" aria-hidden />
        <span className="gmail__label">Gmail authorization expired — {state.account}</span>
        <a className="gmail__button" href="/api/gmail/connect">
          Reconnect Gmail
        </a>
      </div>
    );
  }

  return (
    <div className="gmail gmail--ok">
      <span className="gmail__dot" aria-hidden />
      <span className="gmail__label">
        Gmail connected — {state.account}
        {!sync.ok ? " (last sync failed; showing earlier mail)" : null}
      </span>
      <form method="post" action="/api/gmail/disconnect">
        <button type="submit" className="gmail__button gmail__button--muted">
          Disconnect
        </button>
      </form>
    </div>
  );
}

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
    <div className="card__actions">
      <div className="actions">
        {(["acted", "snoozed", "dismissed"] as const).map((action) => (
          <form action={actOnWorkItem} key={action}>
            <input type="hidden" name="workItemId" value={item.id} />
            <input type="hidden" name="action" value={action} />
            <input type="hidden" name="revision" value={item.attentionRevision} />
            <button type="submit" className={`action action--${action}`}>
              {action === "acted" ? "Handled" : action === "snoozed" ? "Later" : "Not important"}
            </button>
          </form>
        ))}
      </div>
      {item.suppressionCandidate ? (
        <form action={suppressOriginatorAction} className="actions__suppress">
          <input type="hidden" name="workItemId" value={item.id} />
          <input type="hidden" name="revision" value={item.attentionRevision} />
          {item.suppressionCandidate.expectedSuppressionHeadEventId ? (
            <input
              type="hidden"
              name="expectedSuppressionHeadEventId"
              value={item.suppressionCandidate.expectedSuppressionHeadEventId}
            />
          ) : null}
          <button type="submit" className="action action--suppress">
            Don't show future work from {item.suppressionCandidate.displayName} (
            {item.suppressionCandidate.originator.namespace}: {item.suppressionCandidate.originator.id})
          </button>
        </form>
      ) : null}
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
          {item.commitment.toFixed(2)} · Capacity {item.capacity.toFixed(2)} · Importance{" "}
          {item.importance.toFixed(2)}.
        </p>
      </details>

      <ActionButtons item={item} />
    </article>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = await readMissionControl();
  const now = new Date(view.generatedAt);
  const params = await searchParams;
  const callbackKey = typeof params.gmail === "string" ? params.gmail : undefined;
  const callbackMessage = callbackKey ? CALLBACK_MESSAGES[callbackKey] : undefined;

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
        {callbackMessage ? <p className="masthead__notice">{callbackMessage}</p> : null}
        <GmailStatus state={view.gmail} sync={view.gmailSync} />
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

      {view.suppressedOriginators.length > 0 ? (
        <section className="section">
          <h2 className="section__label section__label--muted">Muted senders & originators</h2>
          <ul className="muted-list">
            {view.suppressedOriginators.map((suppressed) => (
              <li key={suppressed.suppressionEventId} className="muted-item">
                <span>
                  {suppressed.originator.namespace}: {suppressed.originator.id}
                </span>
                <form action={unsuppressOriginatorAction}>
                  <input type="hidden" name="suppressionEventId" value={suppressed.suppressionEventId} />
                  <button type="submit" className="action action--unmute">
                    Unmute
                  </button>
                </form>
              </li>
            ))}
          </ul>
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
