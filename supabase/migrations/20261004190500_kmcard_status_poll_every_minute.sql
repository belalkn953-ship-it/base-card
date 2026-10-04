BEGIN;
DO $migration$
DECLARE v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id
  FROM cron.job
  WHERE active AND command LIKE '%/functions/v1/kmcard-proxy%'
  ORDER BY jobid DESC
  LIMIT 1;
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.alter_job(v_job_id, schedule => '* * * * *');
  END IF;
END;
$migration$;
COMMIT;
