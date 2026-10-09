import { parentPort, workerData } from "node:worker_threads";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

// Cada worker abre a sua própria conexão ao mesmo arquivo e aprova a mesma missão, com as suas chaves.
// Todos esperam na barreira e largam juntos, para a primeira aprovação ser uma corrida de verdade.
const { path, missionId, keys, barrier } = workerData as { path: string; missionId: string; keys: string[]; barrier: SharedArrayBuffer };
const app = createApp(openDatabase(path));
const flags = new Int32Array(barrier);
Atomics.add(flags, 1, 1); // pronto
Atomics.wait(flags, 0, 0); // espera o sinal de largada

const statuses: number[] = [];
for (const key of keys) {
  const res = await app.request("/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mission_id: missionId, approved_at: "2026-03-12T18:11:00.000Z", idempotency_key: key }),
  });
  statuses.push(res.status);
}
parentPort?.postMessage(statuses);
