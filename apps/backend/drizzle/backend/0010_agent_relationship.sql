-- 0010: Agent relationship graph (assigns_to / collaborates_with)
CREATE TABLE IF NOT EXISTS agent_relationship (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  rel_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  instruction TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rel_unique ON agent_relationship(from_agent, to_agent, rel_type);
CREATE INDEX IF NOT EXISTS idx_agent_rel_from ON agent_relationship(from_agent);
CREATE INDEX IF NOT EXISTS idx_agent_rel_to ON agent_relationship(to_agent);
