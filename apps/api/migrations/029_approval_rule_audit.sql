-- Approval rule change audit trail (OS governance infrastructure)
CREATE TABLE IF NOT EXISTS approval_rule_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES approval_rules(rule_id),
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  prev_snapshot JSONB,
  new_snapshot JSONB,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rule_audit_rule ON approval_rule_audit(rule_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_audit_tenant ON approval_rule_audit(tenant_id, changed_at DESC);
