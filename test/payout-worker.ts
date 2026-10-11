import { parentPort, workerData } from "node:worker_threads";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

// Cada worker abre a sua conexão ao mesmo arquivo e manda uma sequência de callbacks do provedor; todos largam juntos.
const { path, payout, statuses, barrier } = workerData as { path: string; payout: string; statuses: string[]; barrier: SharedArrayBuffer };
const app = createApp(openDatabase(path));
const flags = new Int32Array(barrier);
Atomics.add(flags, 1, 1);
Atomics.wait(flags, 0, 0);

const codes: number[] = [];
for (const provider_status of statuses) {
  const res = await app.request(`/payouts/${payout}/provider`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider_status }) });
  codes.push(res.status);
}
parentPort?.postMessage(codes);
