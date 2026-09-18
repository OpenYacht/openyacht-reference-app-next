// An in-process ReplayGuard. It protects a single long-lived server process;
// on a serverless host each instance has its own memory, so treat it there as
// best effort and back the port with a shared store if replays matter.
import { systemClock, type Clock, type ReplayGuard, type RequestTuple } from "./ports";
import { TIMESTAMP_WINDOW_SECONDS } from "./verifier";

export class InMemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  async isReplay(tuple: RequestTuple): Promise<boolean> {
    this.prune();
    return this.seen.has(keyOf(tuple));
  }

  async remember(tuple: RequestTuple): Promise<void> {
    // A tuple can only verify while its timestamp is inside the window, so
    // twice the window is always long enough to keep it.
    this.seen.set(keyOf(tuple), this.clock.now().getTime() + TIMESTAMP_WINDOW_SECONDS * 2000);
  }

  private prune(): void {
    const now = this.clock.now().getTime();
    for (const [key, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(key);
  }
}

function keyOf(tuple: RequestTuple): string {
  return `${tuple.node}\n${tuple.timestamp}\n${tuple.signature}`;
}
