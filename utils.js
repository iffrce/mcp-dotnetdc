import { promisify } from 'util';
import { exec } from 'child_process';

export const execAsync = promisify(exec);

export function buildKey(tool, args) {
  return `${tool}:${JSON.stringify(args)}`;
}

export async function withConcurrencyLimitFactory(max) {
  let active = 0;
  const queue = [];
  return async function withConcurrencyLimit(fn) {
    if (active >= max) {
      await new Promise(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}


