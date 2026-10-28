-- Readiness is written only by the snapshot publisher after visibility checks.
CREATE TABLE embedding_generations (
  revision TEXT PRIMARY KEY REFERENCES snapshots(revision),
  generation TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','unavailable'))
);
