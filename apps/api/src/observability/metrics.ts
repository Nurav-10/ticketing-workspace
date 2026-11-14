import { performance } from 'node:perf_hooks';
import express, { type Request, type RequestHandler, type Router } from 'express';

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const;
type HttpMethod = typeof HTTP_METHODS[number];
type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';

const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface RequestSamples {
  count: number;
  durationSum: number;
  bucketCounts: number[];
}

export interface RequestObservation {
  finish(statusCode: number): void;
  abort(): void;
}

function normalizeMethod(value: string): HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value) && value !== 'OTHER' ? value as HttpMethod : 'OTHER';
}

function statusClass(statusCode: number): StatusClass {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return 'other';
  return `${Math.floor(statusCode / 100)}xx` as StatusClass;
}

function label(method: HttpMethod, status: StatusClass): string {
  return `{method="${method}",status_class="${status}"}`;
}

/** In-memory, bounded-cardinality HTTP request metrics; no request data is retained. */
export class ApiMetrics {
  private readonly requests = new Map<string, RequestSamples>();
  private readonly inFlight = new Map<HttpMethod, number>();
  private readonly aborted = new Map<HttpMethod, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  startRequest(method: string): RequestObservation {
    const normalizedMethod = normalizeMethod(method);
    const startedAt = this.now();
    this.inFlight.set(normalizedMethod, (this.inFlight.get(normalizedMethod) ?? 0) + 1);
    let completed = false;

    const release = () => {
      this.inFlight.set(normalizedMethod, Math.max(0, (this.inFlight.get(normalizedMethod) ?? 1) - 1));
    };
    return {
      finish: (statusCode) => {
        if (completed) return;
        completed = true;
        const elapsed = (this.now() - startedAt) / 1000;
        const elapsedSeconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
        const status = statusClass(statusCode);
        const key = `${normalizedMethod}|${status}`;
        const samples = this.requests.get(key) ?? { count: 0, durationSum: 0, bucketCounts: Array(LATENCY_BUCKETS_SECONDS.length).fill(0) as number[] };
        samples.count += 1;
        samples.durationSum += elapsedSeconds;
        LATENCY_BUCKETS_SECONDS.forEach((bucket, index) => {
          if (elapsedSeconds <= bucket) samples.bucketCounts[index] = (samples.bucketCounts[index] ?? 0) + 1;
        });
        this.requests.set(key, samples);
        release();
      },
      abort: () => {
        if (completed) return;
        completed = true;
        this.aborted.set(normalizedMethod, (this.aborted.get(normalizedMethod) ?? 0) + 1);
        release();
      },
    };
  }

  /** Prometheus text exposition containing only bounded method/status labels and aggregates. */
  renderPrometheus(): string {
    const lines = [
      '# HELP api_http_requests_total Completed HTTP requests.',
      '# TYPE api_http_requests_total counter',
    ];
    for (const [key, samples] of [...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [method, status] = key.split('|') as [HttpMethod, StatusClass];
      lines.push(`api_http_requests_total${label(method, status)} ${samples.count}`);
    }

    lines.push(
      '# HELP api_http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE api_http_request_duration_seconds histogram',
    );
    for (const [key, samples] of [...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [method, status] = key.split('|') as [HttpMethod, StatusClass];
      LATENCY_BUCKETS_SECONDS.forEach((bucket, index) => {
        lines.push(`api_http_request_duration_seconds_bucket${label(method, status).slice(0, -1)},le="${bucket}"} ${samples.bucketCounts[index] ?? 0}`);
      });
      lines.push(`api_http_request_duration_seconds_bucket${label(method, status).slice(0, -1)},le="+Inf"} ${samples.count}`);
      lines.push(`api_http_request_duration_seconds_sum${label(method, status)} ${samples.durationSum}`);
      lines.push(`api_http_request_duration_seconds_count${label(method, status)} ${samples.count}`);
    }

    lines.push(
      '# HELP api_http_requests_in_flight Requests currently being handled.',
      '# TYPE api_http_requests_in_flight gauge',
    );
    for (const method of HTTP_METHODS) {
      lines.push(`api_http_requests_in_flight{method="${method}"} ${this.inFlight.get(method) ?? 0}`);
    }

    lines.push(
      '# HELP api_http_client_aborted_total Requests closed before the response finished.',
      '# TYPE api_http_client_aborted_total counter',
    );
    for (const [method, count] of [...this.aborted.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`api_http_client_aborted_total{method="${method}"} ${count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Records method/status/latency only; it intentionally never reads URL, headers, cookies, or body. */
export function createHttpMetricsMiddleware(metrics: ApiMetrics): RequestHandler {
  return (_request, response, next) => {
    const observation = metrics.startRequest(_request.method);
    response.once('finish', () => observation.finish(response.statusCode));
    response.once('close', () => observation.abort());
    next();
  };
}

export type MetricsAuthorizer = (request: Request) => boolean | Promise<boolean>;

/**
 * Creates a metrics endpoint only with an explicit authorization policy. Denied or
 * failing authorization falls through to the app's normal not-found handler.
 */
export function createMetricsRouter(metrics: ApiMetrics, authorize: MetricsAuthorizer): Router {
  if (typeof authorize !== 'function') throw new Error('Metrics endpoint requires an authorization policy');
  const router = express.Router();
  router.get('/metrics', async (request, response, next) => {
    let allowed = false;
    try { allowed = await authorize(request); } catch { allowed = false; }
    if (!allowed) {
      next();
      return;
    }
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    response.send(metrics.renderPrometheus());
  });
  return router;
}
