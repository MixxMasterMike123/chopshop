PRAGMA foreign_keys = ON;

ALTER TABLE email_deliveries
ADD COLUMN job_fingerprint TEXT CHECK (
  job_fingerprint IS NULL OR length(job_fingerprint) = 64
);

CREATE TRIGGER email_deliveries_fingerprint_required
BEFORE INSERT ON email_deliveries
FOR EACH ROW
WHEN NEW.job_fingerprint IS NULL OR length(NEW.job_fingerprint) <> 64
BEGIN
  SELECT RAISE(ABORT, 'job fingerprint is required');
END;
