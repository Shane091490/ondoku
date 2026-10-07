// Runs article extraction (jsdom + Readability, CPU-heavy on big pages) off the main thread.
import { parentPort } from 'node:worker_threads';
import { extractFromHtml, extractFromText, extractFromSuppliedHtml } from './extract.js';

const KINDS = { html: extractFromHtml, text: extractFromText, supplied: extractFromSuppliedHtml };

parentPort.on('message', ({ id, kind, args }) => {
  try {
    parentPort.postMessage({ id, result: KINDS[kind](...args) });
  } catch (e) {
    parentPort.postMessage({ id, error: { message: e.message, name: e.constructor?.name } });
  }
});
