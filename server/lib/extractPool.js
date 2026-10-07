// One extraction worker, restarted if it crashes or a page hangs it. Calls are queued in order.
import { Worker } from 'node:worker_threads';
import { ExtractError } from './extract.js';

const TIMEOUT_MS = 60000;
let worker = null;
let seq = 0;
const pending = new Map();

function spawn() {
  worker = new Worker(new URL('./extractWorker.js', import.meta.url), { execArgv: ['--no-warnings=ExperimentalWarning'] });
  worker.unref();
  worker.on('message', ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(error.name === 'ExtractError' ? new ExtractError(error.message) : new Error(error.message));
    else p.resolve(result);
  });
  const failAll = (err) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(err); pending.delete(id); }
    worker = null;
  };
  worker.on('error', (e) => failAll(new Error(`Extraction failed: ${e.message}`)));
  worker.on('exit', (code) => { if (code !== 0) failAll(new Error('Extraction worker stopped')); else worker = null; });
}

function run(kind, args) {
  if (!worker) spawn();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new ExtractError('The page took too long to process'));
      worker?.terminate();
      worker = null;
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, kind, args });
  });
}

export const extractHtml = (html, url) => run('html', [html, url]);
export const extractText = (text, opts) => run('text', [text, opts]);
export const extractSupplied = (html, opts) => run('supplied', [html, opts]);
