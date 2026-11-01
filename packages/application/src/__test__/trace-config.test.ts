import { it, expect } from 'vitest';
import { convertConfigurationV1, createConfigManager } from '../config.js';
import { createTestConfiguration } from '../../../../tests/support/config.js';
function legacy() {
  const original = createTestConfiguration().configuration;
  const { traces: _traces, trace_queries: _queries, ...limits } = original.limits;
  const { trace_days: _trace, ...retention } = original.retention;
  const projects = original.projects.map(
    ({ trace_policy: _policy, trace_quota: _quota, ...project }) => project,
  );
  return { ...original, schema_version: '1', limits, retention, projects };
}
it('converts offline schema 1 config without changing event rules or expanding account permissions', () => {
  const original = legacy();
  const result = convertConfigurationV1(original);
  expect(result.schema_version).toBe('2');
  expect(result.projects[0].events).toEqual(original.projects[0].events);
  expect(result.projects[0].service_accounts).toEqual(original.projects[0].service_accounts);
  expect(result.projects[0].trace_policy.span).toEqual({});
  expect(result.projects[0].trace_policy.tracestate_rules).toEqual({});
  expect(() => createConfigManager(original)).toThrow();
  expect(createConfigManager(result).current().value.schema_version).toBe('2');
});
it('rejects unsafe trace policies and atomically preserves the active config', () => {
  const fixture = createTestConfiguration();
  const manager = createConfigManager(fixture.configuration);
  for (const rule of [
    { type: 'string' },
    { type: 'array' },
    { type: 'int', min: '9223372036854775808' },
    { type: 'double', min: 3, max: 2 },
    { type: 'kvlist' },
  ]) {
    const changed = structuredClone(fixture.configuration);
    changed.revision++;
    Object.assign(changed.projects[0].trace_policy.span, { bad: rule });
    expect(() => manager.update(changed)).toThrow();
    expect(manager.status().active_revision).toBe(1);
  }
  const mixed = structuredClone(fixture.configuration);
  mixed.projects[0].service_accounts[0].permissions.push('read:traces');
  expect(() => createConfigManager(mixed)).toThrow();
});
