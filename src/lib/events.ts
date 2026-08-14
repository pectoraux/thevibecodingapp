// Forge — build event / audit log helper.

import { db } from "@/lib/db";
import type { BuildEventType } from "@/lib/types";

export interface EmitEventInput {
  projectId: string;
  type: BuildEventType | string;
  level?: "info" | "warn" | "error" | "success";
  message: string;
  taskId?: string;
  agentType?: string;
  payload?: string;
}

export async function ensureBuildEvent(input: EmitEventInput) {
  try {
    return await db.buildEvent.create({
      data: {
        projectId: input.projectId,
        type: input.type,
        level: input.level ?? "info",
        message: input.message,
        taskId: input.taskId,
        agentType: input.agentType,
        payload: input.payload,
      },
    });
  } catch (err) {
    // Never let logging crash the orchestrator.
    console.error("[ensureBuildEvent] failed:", err);
    return null;
  }
}

export async function listEvents(projectId: string, limit = 200) {
  return db.buildEvent.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
