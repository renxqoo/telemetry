import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalize } from '../../protocol/src/index.js';
import type { Envelope, Source, TelemetryEvent } from '../../protocol/src/types.js';
import type { Configuration, ProjectConfiguration, PropertyRule } from './config.js';
import { HttpError } from './errors.js';

export function hash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
export function authenticate(configuration: Configuration, authorization: string | undefined) {
  const token = /^Bearer ([A-Za-z0-9_-]{1,64})\.([^\s]+)$/.exec(authorization ?? '');
  const actual = createHash('sha256')
    .update(token?.[2] ?? '')
    .digest();
  let matched:
    | { project: ProjectConfiguration; account: ProjectConfiguration['service_accounts'][number] }
    | undefined;
  for (const project of configuration.projects)
    for (const account of project.service_accounts) {
      const equal = timingSafeEqual(actual, Buffer.from(account.secret_sha256, 'hex'));
      if (equal && account.key_id === token?.[1] && Buffer.byteLength(token[2]!, 'utf8') >= 32)
        matched = { project, account };
    }
  if (!matched) throw new HttpError('unauthenticated');
  return matched;
}
function permitted(value: unknown, rule: PropertyRule): boolean {
  if (value === null) return rule.nullable;
  if (typeof value !== rule.type) return false;
  if (rule.values && !rule.values.includes(value as never)) return false;
  return (
    typeof value !== 'number' ||
    ((rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max))
  );
}
function frameFile(value: string): string | undefined {
  const file = value.trim();
  if (!file || file.includes('eval at')) return undefined;
  for (const character of file) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return undefined;
  }
  if (/^[A-Za-z]:[\\/]/.test(file)) return file.split(/[?#]/, 1)[0];
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(file)?.[1]?.toLowerCase();
  if (scheme) {
    if (!['http', 'https', 'file', 'node', 'webpack', 'webpack-internal'].includes(scheme))
      return undefined;
    if (scheme === 'node' && !/^node:[A-Za-z0-9_./-]+(?:[?#].*)?$/.test(file)) return undefined;
    if (scheme.startsWith('webpack') && !/^webpack(?:-internal)?:\/\//.test(file)) return undefined;
    try {
      const url = new URL(file);
      if (url.username || url.password) return undefined;
      if (['http', 'https', 'file'].includes(scheme)) return url.pathname || undefined;
      return file.split(/[?#]/, 1)[0];
    } catch {
      return undefined;
    }
  }
  if (file === 'native' || file.startsWith('//') || file.includes('://')) return undefined;
  return file.split(/[?#]/, 1)[0] || undefined;
}

export function projectEvents(envelope: Envelope, project: ProjectConfiguration): TelemetryEvent[] {
  const failures: { index: number; id: string; reason: string }[] = [];
  const result = envelope.events.map((event, index) => {
    const rules =
      event.kind === 'error'
        ? project.error_policy.properties
        : Object.hasOwn(project.events, event.name)
          ? project.events[event.name]
          : undefined;
    if (
      !rules ||
      Object.entries(event.properties).some(
        ([key, value]) => !Object.hasOwn(rules, key) || !permitted(value, rules[key]!),
      ) ||
      (event.error?.code !== undefined && !project.error_policy.codes.includes(event.error.code))
    )
      failures.push({ index, id: event.id, reason: 'unregistered_event_or_property' });
    const projected = structuredClone(event);
    if (
      projected.error?.safe_message !== undefined &&
      !project.error_policy.safe_messages.includes(projected.error.safe_message)
    )
      delete projected.error.safe_message;
    if (projected.error)
      projected.error.frames = projected.error.frames.flatMap((frame) => {
        const file = frameFile(frame.file);
        return file ? [{ ...frame, file }] : [];
      });
    return projected;
  });
  if (failures.length) throw new HttpError('invalid_event', 'not_committed', failures);
  return result;
}
export function fingerprint(
  projectId: string,
  envelope: Envelope,
  source: Source,
  event: TelemetryEvent,
): string | undefined {
  if (!event.error) return undefined;
  return `v1:${hash({ project_id: projectId, environment: envelope.environment, service: envelope.service, source, release: envelope.release, type: event.error.type, code: event.error.code ?? null, frames: event.error.frames.slice(0, 3) })}`;
}
