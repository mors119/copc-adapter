import { Getter } from 'copc';
import { HttpRangeByteSource } from '../range/httpRangeSource';
import { ProjectOwnedByteSource, RangeRequestDiagnosticsRecorder } from '../range/requestDiagnostics';
import type { RangeReadOptions, RangeValidationPolicy } from '../range/types';

export type CopcRangeGetter = (
  begin: number,
  end: number,
  options?: RangeReadOptions,
) => Promise<Uint8Array>;

export type CopcGetterOptions = {
  signal?: AbortSignal;
  rangeRequestDiagnostics?: RangeRequestDiagnosticsRecorder;
  rangeValidation?: RangeValidationPolicy;
};

function isHttpSource(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://');
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function createCopcGetter(source: string, options: CopcGetterOptions = {}): CopcRangeGetter {
  if (isHttpSource(source) || isBrowser()) {
    const resolvedSource = isHttpSource(source)
      ? source
      : new URL(source, window.location.href).toString();
    const byteSource = new ProjectOwnedByteSource(
      new HttpRangeByteSource(resolvedSource, {
        rangeValidation: options.rangeValidation,
      }),
      options.signal,
      options.rangeRequestDiagnostics ?? new RangeRequestDiagnosticsRecorder(),
    );
    return (begin, end, readOptions) => byteSource.readRange(begin, end - begin, {
      signal: readOptions?.signal,
    });
  }

  return Getter.create(source);
}
