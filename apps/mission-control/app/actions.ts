"use server";

import { revalidatePath } from "next/cache";
import {
  recordAction,
  recordOriginatorSuppression,
  recordOriginatorUnsuppression,
  WORK_ITEM_ACTIONS,
  type WorkItemAction,
} from "../lib/orion";

function isWorkItemAction(value: string): value is WorkItemAction {
  return (WORK_ITEM_ACTIONS as readonly string[]).includes(value);
}

export async function actOnWorkItem(formData: FormData): Promise<void> {
  const workItemId = String(formData.get("workItemId") ?? "");
  const action = String(formData.get("action") ?? "");
  // The revision token is an optimistic-concurrency check only; the server derives
  // Subject and basis itself and rejects the action if this no longer matches the
  // currently-visible revision (see recordAction).
  const revision = String(formData.get("revision") ?? "");

  // Validate hostile form input at runtime — never coerce an unknown action
  // into a default (that previously turned anything into "dismissed"). The
  // Subject and attention basis are derived server-side from the surfaced Work
  // Item (see recordAction), never trusted from the client.
  if (!workItemId || !isWorkItemAction(action) || !revision) {
    return;
  }

  await recordAction(workItemId, action, revision);
  // Revalidate regardless: if the item was already resolved elsewhere, this
  // refreshes the view to current truth rather than failing silently.
  revalidatePath("/");
}

export async function suppressOriginatorAction(formData: FormData): Promise<void> {
  const workItemId = String(formData.get("workItemId") ?? "");
  const revision = String(formData.get("revision") ?? "");
  const expectedSuppressionHeadEventId = formData.get("expectedSuppressionHeadEventId")
    ? String(formData.get("expectedSuppressionHeadEventId"))
    : undefined;
  const reason = formData.get("reason") ? String(formData.get("reason")) : undefined;

  if (!workItemId || !revision) {
    return;
  }

  await recordOriginatorSuppression(workItemId, revision, expectedSuppressionHeadEventId, reason);
  revalidatePath("/");
}

export async function unsuppressOriginatorAction(formData: FormData): Promise<void> {
  const suppressionEventId = String(formData.get("suppressionEventId") ?? "");
  const reason = formData.get("reason") ? String(formData.get("reason")) : undefined;

  if (!suppressionEventId) {
    return;
  }

  await recordOriginatorUnsuppression(suppressionEventId, reason);
  revalidatePath("/");
}
