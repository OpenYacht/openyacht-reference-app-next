import "server-only";
import { supabaseNodeStore } from "./store";

// Setup completes once and never reverts, so a positive answer is remembered
// for the life of the process; only an unfinished install keeps asking.
let completed = false;

export async function isSetupComplete(): Promise<boolean> {
  if (completed) return true;
  completed = (await supabaseNodeStore.getState()).setupCompleted;
  return completed;
}
