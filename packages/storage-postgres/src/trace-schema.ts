import { traceBounds } from '../../protocol/src/traces/types.js';
export const traceSchema = `
CREATE TABLE IF NOT EXISTS telemetry.span_receipts (
 project_id text NOT NULL,environment text NOT NULL,trace_id text NOT NULL,span_id text NOT NULL,service text NOT NULL,
 canonicalization_version integer NOT NULL DEFAULT 1 CHECK(canonicalization_version=1),payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),first_received_at timestamptz NOT NULL,retain_until timestamptz NOT NULL,tombstone_until timestamptz NOT NULL,
 first_operation_id uuid NOT NULL,confirmation_nonce uuid NOT NULL,policy_version text NOT NULL,
 PRIMARY KEY(project_id,environment,trace_id,span_id),UNIQUE(project_id,environment,trace_id,span_id,service),
 CHECK(trace_id ~ '^[a-f0-9]{32}$' AND trace_id <> repeat('0',32)),CHECK(span_id ~ '^[a-f0-9]{16}$' AND span_id <> repeat('0',16)),
 CHECK(retain_until>first_received_at AND tombstone_until>retain_until)
);
CREATE TABLE IF NOT EXISTS telemetry.trace_spans (
 project_id text NOT NULL,environment text NOT NULL,trace_id text NOT NULL,span_id text NOT NULL,service text NOT NULL,
 received_at timestamptz NOT NULL,retain_until timestamptz NOT NULL,policy_version text NOT NULL,name text NOT NULL,
 parent_span_id text,kind integer NOT NULL,flags bigint NOT NULL CHECK(flags>=0 AND flags<=4294967295),status_message text NOT NULL,
 start_ns numeric(20,0) NOT NULL CHECK(start_ns>0 AND start_ns<=18446744073709551615),end_ns numeric(20,0) NOT NULL CHECK(end_ns>=start_ns AND end_ns<=18446744073709551615),
 status_code integer NOT NULL,duration_ns numeric(20,0) NOT NULL CHECK(duration_ns>=0 AND duration_ns<=18446744073709551615),
 safe_payload jsonb NOT NULL,safe_payload_bytes integer NOT NULL CHECK(safe_payload_bytes>0 AND safe_payload_bytes<=${traceBounds.maxSafeSpanBytes}),
 PRIMARY KEY(project_id,environment,received_at,trace_id,span_id),
 FOREIGN KEY(project_id,environment,trace_id,span_id,service) REFERENCES telemetry.span_receipts(project_id,environment,trace_id,span_id,service),CHECK(retain_until>received_at),CHECK(duration_ns=end_ns-start_ns),CHECK(parent_span_id IS NULL OR (parent_span_id ~ '^[a-f0-9]{16}$' AND parent_span_id <> repeat('0',16) AND parent_span_id<>span_id))
) PARTITION BY RANGE(received_at);
CREATE INDEX IF NOT EXISTS span_page_idx ON telemetry.trace_spans(project_id,environment,received_at DESC,trace_id DESC,span_id DESC);
CREATE INDEX IF NOT EXISTS span_trace_idx ON telemetry.trace_spans(project_id,environment,trace_id,received_at DESC,span_id DESC);
CREATE INDEX IF NOT EXISTS span_service_idx ON telemetry.trace_spans(project_id,environment,service,received_at DESC);
CREATE INDEX IF NOT EXISTS span_expiry_idx ON telemetry.span_receipts(tombstone_until);
ALTER TABLE telemetry.span_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.span_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.trace_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.trace_spans FORCE ROW LEVEL SECURITY;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['span_receipts','trace_spans'] LOOP
 EXECUTE format('DROP POLICY IF EXISTS span_collector ON telemetry.%I',relation);
 EXECUTE format('CREATE POLICY span_collector ON telemetry.%I TO telemetry_collector USING (project_id=current_setting(''telemetry.project_id'',true) AND environment=current_setting(''telemetry.environment'',true) AND service=ANY(COALESCE(NULLIF(current_setting(''telemetry.services'',true),'''')::text[],ARRAY[]::text[]))) WITH CHECK (project_id=current_setting(''telemetry.project_id'',true) AND environment=current_setting(''telemetry.environment'',true) AND service=ANY(COALESCE(NULLIF(current_setting(''telemetry.services'',true),'''')::text[],ARRAY[]::text[])))',relation);
 EXECUTE format('DROP POLICY IF EXISTS span_query ON telemetry.%I',relation);
 EXECUTE format('CREATE POLICY span_query ON telemetry.%I FOR SELECT TO telemetry_query USING (project_id=current_setting(''telemetry.project_id'',true) AND environment=current_setting(''telemetry.environment'',true) AND service=ANY(COALESCE(NULLIF(current_setting(''telemetry.services'',true),'''')::text[],ARRAY[]::text[])) AND ''span''=ANY(COALESCE(NULLIF(current_setting(''telemetry.kinds'',true),'''')::text[],ARRAY[]::text[])))',relation);
 EXECUTE format('DROP POLICY IF EXISTS span_maintenance ON telemetry.%I',relation);
 EXECUTE format('CREATE POLICY span_maintenance ON telemetry.%I TO telemetry_owner USING(true) WITH CHECK(true)',relation);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION telemetry.confirm_span_receipts(keys jsonb,nonce uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE touched integer;
BEGIN
 IF jsonb_typeof(keys)<>'array' OR jsonb_array_length(keys)>${traceBounds.maxSpans} OR NULLIF(current_setting('telemetry.project_id',true),'') IS NULL OR NULLIF(current_setting('telemetry.environment',true),'') IS NULL THEN RAISE EXCEPTION 'Invalid confirmation scope'; END IF;
 PERFORM 1 FROM telemetry.span_receipts r JOIN jsonb_to_recordset(keys) AS k(trace_id text,span_id text) ON r.trace_id=k.trace_id AND r.span_id=k.span_id
 WHERE r.project_id=current_setting('telemetry.project_id',true) AND r.environment=current_setting('telemetry.environment',true) ORDER BY r.trace_id,r.span_id FOR UPDATE OF r;
 UPDATE telemetry.span_receipts r SET confirmation_nonce=nonce FROM jsonb_to_recordset(keys) AS k(trace_id text,span_id text)
 WHERE r.project_id=current_setting('telemetry.project_id',true) AND r.environment=current_setting('telemetry.environment',true) AND r.trace_id=k.trace_id AND r.span_id=k.span_id;
GET DIAGNOSTICS touched=ROW_COUNT;
RETURN touched;
END $$;
REVOKE ALL ON FUNCTION telemetry.confirm_span_receipts(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry.confirm_span_receipts(jsonb,uuid) TO telemetry_collector;
REVOKE ALL ON telemetry.span_receipts,telemetry.trace_spans FROM PUBLIC;
GRANT SELECT,INSERT ON telemetry.span_receipts,telemetry.trace_spans TO telemetry_collector;
GRANT SELECT ON telemetry.span_receipts,telemetry.trace_spans TO telemetry_query;
CREATE TABLE IF NOT EXISTS telemetry.trace_query_audit(
 audit_id uuid PRIMARY KEY,project_id text NOT NULL,environment text NOT NULL,actor_key_id text NOT NULL,request_id text NOT NULL,query_kind text NOT NULL CHECK(query_kind IN ('spans','trace')),
 query_digest text NOT NULL,services_digest text NOT NULL,as_of timestamptz NOT NULL,row_count integer NOT NULL CHECK(row_count>=0),created_at timestamptz NOT NULL,retain_until timestamptz NOT NULL CHECK(retain_until>created_at)
);
CREATE INDEX IF NOT EXISTS trace_audit_expiry_idx ON telemetry.trace_query_audit(retain_until);
ALTER TABLE telemetry.trace_query_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.trace_query_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trace_audit_query ON telemetry.trace_query_audit;
CREATE POLICY trace_audit_query ON telemetry.trace_query_audit FOR INSERT TO telemetry_query WITH CHECK(project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true) AND 'span'=ANY(COALESCE(NULLIF(current_setting('telemetry.kinds',true),'')::text[],ARRAY[]::text[])));
DROP POLICY IF EXISTS trace_audit_maintenance ON telemetry.trace_query_audit;
CREATE POLICY trace_audit_maintenance ON telemetry.trace_query_audit TO telemetry_owner USING(true) WITH CHECK(true);
REVOKE ALL ON telemetry.trace_query_audit FROM PUBLIC;
GRANT INSERT ON telemetry.trace_query_audit TO telemetry_query;
`;
