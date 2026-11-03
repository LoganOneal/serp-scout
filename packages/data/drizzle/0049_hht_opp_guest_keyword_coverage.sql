CREATE TABLE IF NOT EXISTS hht_opp_guest_serp_reviews (
  serp_result_id integer PRIMARY KEY REFERENCES hht_opp_guest_serp_results(id) ON DELETE CASCADE,
  root_domain text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('KNOWN', 'SKIP', 'PURSUE', 'UNRESOLVED')),
  reason text NOT NULL,
  source_url text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hht_opp_guest_serp_reviews_domain_idx
  ON hht_opp_guest_serp_reviews (root_domain);

CREATE OR REPLACE VIEW hht_opp_guest_keyword_coverage AS
SELECT
  k.id AS keyword_id,
  k.keyword,
  k.status AS fetch_status,
  k.results_seen AS results_returned,
  count(r.id)::integer AS stored_results,
  count(DISTINCT v.root_domain)::integer AS accounted_domains,
  count(DISTINCT v.root_domain) FILTER (WHERE v.decision = 'KNOWN')::integer AS known_domains,
  count(DISTINCT v.root_domain) FILTER (WHERE v.decision = 'SKIP')::integer AS skipped_domains,
  count(DISTINCT v.root_domain) FILTER (WHERE v.decision = 'PURSUE')::integer AS pursued_domains,
  count(DISTINCT v.root_domain) FILTER (WHERE v.decision = 'UNRESOLVED')::integer AS unresolved_domains,
  count(r.id) FILTER (WHERE v.serp_result_id IS NULL)::integer AS pending_results,
  CASE
    WHEN k.fetched_at IS NULL THEN 'NOT_FETCHED'
    WHEN count(r.id) = 0 THEN 'NO_DATA'
    WHEN count(r.id) FILTER (WHERE v.serp_result_id IS NULL OR v.decision = 'UNRESOLVED') > 0 THEN 'PENDING'
    ELSE 'COMPLETE'
  END AS evaluation_status,
  (
    k.fetched_at IS NOT NULL AND count(r.id) > 0
    AND count(r.id) FILTER (WHERE v.serp_result_id IS NULL OR v.decision = 'UNRESOLVED') = 0
  ) AS evaluation_complete
FROM hht_opp_guest_keywords k
LEFT JOIN hht_opp_guest_serp_results r ON r.keyword_id = k.id
LEFT JOIN hht_opp_guest_serp_reviews v ON v.serp_result_id = r.id
GROUP BY k.id;
