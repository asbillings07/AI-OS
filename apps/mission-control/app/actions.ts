"use server";

import { revalidatePath } from "next/cache";
import { recordAction, type WorkItemAction } from "../lib/orion";

export async function actOnWorkItem(formData: FormData): Promise<void> {
  const workItemId = String(formData.get("workItemId") ?? "");
  const threadId = String(formData.get("threadId") ?? "");
  const action = String(formData.get("action") ?? "") as WorkItemAction;
  if (!workItemId || !threadId) return;

  await recordAction(workItemId, threadId, action);
  revalidatePath("/");
}
