import type {
  SyncTransport,
  SyncTransportRequest,
  SyncTransportResult,
} from '../../src/domain/sync/SyncTransport';

/**
 * A programmable, recording fake for SyncTransport. Tests configure
 * `results` (consumed in order, one per call.send()) or a single
 * `result` to return on every call, and inspect `calls` afterward to
 * assert exactly what was sent.
 */
export class FakeSyncTransport implements SyncTransport {
  readonly calls: SyncTransportRequest[] = [];
  private readonly queuedResults: SyncTransportResult[];
  private readonly defaultResult: SyncTransportResult;

  constructor(options: { result?: SyncTransportResult; results?: SyncTransportResult[] } = {}) {
    this.defaultResult = options.result ?? { outcome: 'success' };
    this.queuedResults = options.results ? [...options.results] : [];
  }

  async send(request: SyncTransportRequest): Promise<SyncTransportResult> {
    this.calls.push(request);
    return this.queuedResults.length > 0 ? (this.queuedResults.shift() as SyncTransportResult) : this.defaultResult;
  }
}
