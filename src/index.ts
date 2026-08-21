import { start } from './server.js';
import { migrateV3xCatalogAvailability } from './catalogMigrations.js';

function timestampLogs(): void {
  const stamp = () => new Date().toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(`[${stamp()}]`, ...args);
  }
}

timestampLogs();
migrateV3xCatalogAvailability();
start().catch(console.error);
