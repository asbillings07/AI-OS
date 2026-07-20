"use server";

import { revalidatePath } from "next/cache";
import { recordAction, WORK_ITEM_ACTIONS, type WorkItemAction } from "../lib/orion";

function isWorkItemAction(value: string): value is WorkItemAction {
  return (WORK_ITEM_ACTIONS as readonly string[]).includes(value);
}

export async function actOnWorkItem(formData: FormData): Promise<void> {
  const workItemId = String(formData.get("workItemId") ?? "");
  const threadId = String(formData.get("threadId") ?? "");
  const action = String(formData.get("action") ?? "");

  // Validate hostile form input at runtime — never coerce an unknown action
  // into a default (that previously turned anything into "dismissed").
  if (!workItemId || !threadId || !isWorkItemAction(action)) {
    return;
  }

  await recordAction(workItemId, threadId, action);
  // Revalidate regardless: if the item was already resolved elsewhere, this
  // refreshes the view to current truth rather than failing silently.
  revalidatePath("/");
}
