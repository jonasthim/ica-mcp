import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/** Creates a fresh Prometheus registry with build info and HTTP request counts; ICA session gauges are registered by src/sessions/metrics.ts. */
export function createMetrics(version: string) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'ica_hub_' });
  new Gauge({ name: 'ica_hub_build_info', help: 'Build info', labelNames: ['version'], registers: [registry] }).set({ version }, 1);
  const httpRequests = new Counter({ name: 'ica_hub_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status'], registers: [registry] });
  return { registry, httpRequests };
}

export type Metrics = ReturnType<typeof createMetrics>;
