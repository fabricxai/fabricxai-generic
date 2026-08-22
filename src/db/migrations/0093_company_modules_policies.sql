-- Policies for `company_modules` (0092). Same shape as every tenant table: RLS is the
-- second wall (CLAUDE.md rule 2), FORCEd so even the table owner cannot slip past it.
ALTER TABLE company_modules FORCE ROW LEVEL SECURITY;

CREATE POLICY company_modules_tenant_isolation ON company_modules FOR ALL TO fabricxai_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
