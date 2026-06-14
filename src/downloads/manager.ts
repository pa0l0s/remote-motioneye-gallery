import { statSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import type { MotionEyeClient } from "../motioneye/client.js";
import type { FetchGate } from "../remote/fetchGate.js";
import { ensureDownloaded } from "../media/store.js";

export interface DownloadJob {
  id: string;
  cameraId: number;
  label: string;
  total: number;
  done: number;
  failed: number;
  bytes: number;
  status: "running" | "done" | "error" | "canceled";
  createdAt: number;
  updatedAt: number;
}

export interface CreateArgs {
  cameraId: number;
  mediaIds: number[];
  label: string;
}

/**
 * In-memory, user-triggered download jobs. One job runs at a time and each file goes
 * through the shared FetchGate, so batch downloads never flood the GSM link. Jobs are
 * ephemeral (lost on restart) which is fine: the user simply re-triggers.
 */
export class DownloadManager {
  private jobs = new Map<string, DownloadJob>();
  private queue: string[] = [];
  private running = false;
  private cancelSet = new Set<string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly gate: FetchGate,
    private readonly client: MotionEyeClient,
  ) {}

  create(args: CreateArgs): DownloadJob {
    const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: DownloadJob = {
      id,
      cameraId: args.cameraId,
      label: args.label,
      total: args.mediaIds.length,
      done: 0,
      failed: 0,
      bytes: 0,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    (job as DownloadJob & { _ids: number[] })._ids = args.mediaIds;
    this.queue.push(id);
    void this.pump();
    return job;
  }

  list(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job && job.status === "running") this.cancelSet.add(id);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        await this.process(id);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const ids = (job as DownloadJob & { _ids: number[] })._ids ?? [];
    const cam = await this.prisma.camera.findUnique({ where: { id: job.cameraId } });

    for (const mediaId of ids) {
      if (this.cancelSet.has(id)) {
        job.status = "canceled";
        job.updatedAt = Date.now();
        this.cancelSet.delete(id);
        return;
      }
      const mf = await this.prisma.mediaFile.findUnique({ where: { id: mediaId } });
      if (!mf) {
        job.failed++;
        job.updatedAt = Date.now();
        continue;
      }
      try {
        const path = await ensureDownloaded({
          prisma: this.prisma,
          gate: this.gate,
          client: this.client,
          mediaFile: mf,
          remoteCameraId: cam?.motionEyeId,
          force: true, // user asked for it; repairs 0-byte/corrupt too
        });
        try {
          job.bytes += statSync(path).size;
        } catch {
          /* size best-effort */
        }
        job.done++;
      } catch {
        job.failed++;
      }
      job.updatedAt = Date.now();
    }
    if (job.status === "running") job.status = job.failed > 0 ? "error" : "done";
    job.updatedAt = Date.now();
  }
}
