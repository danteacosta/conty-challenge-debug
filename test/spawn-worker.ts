import { Worker } from "node:worker_threads";

/**
 * Sobe um worker escrito em TypeScript. Em Node 22 (a partir do 22.13, onde node:sqlite já não pede flag) o worker
 * só carrega `.ts` com --experimental-strip-types; no Node 24 isso já é o padrão e a flag é inofensiva.
 * Passar a flag aqui, e não só no script do npm, faz `npx vitest` direto funcionar nas duas versões.
 */
export function tsWorker(file: URL, workerData: unknown): Worker {
  return new Worker(file, { workerData, execArgv: [...process.execArgv, "--experimental-strip-types"] });
}
