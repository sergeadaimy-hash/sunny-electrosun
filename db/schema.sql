CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  category TEXT,
  lead_temperature TEXT,
  client_type TEXT,
  language TEXT,
  location TEXT,
  use_case TEXT,
  load_estimate TEXT,
  timeline TEXT,
  products_asked_about TEXT,
  brand_preference TEXT,
  budget_mentioned TEXT,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active TIMESTAMP,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  human_handled INTEGER NOT NULL DEFAULT 0,
  human_handled_at TIMESTAMP,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_message_at TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  intent TEXT,
  language TEXT,
  whatsapp_message_id TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER,
  type TEXT NOT NULL,
  payload TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  payload TEXT,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pending_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  customer_message_id TEXT,
  customer_message_text TEXT,
  classifier_intent TEXT,
  alert_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  owner_reply_text TEXT,
  expiring_warning_sent_at TIMESTAMP,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE INDEX IF NOT EXISTS idx_pending_queries_status ON pending_queries(status);
CREATE INDEX IF NOT EXISTS idx_pending_queries_alert ON pending_queries(alert_message_id);

CREATE TABLE IF NOT EXISTS daily_costs (
  date TEXT PRIMARY KEY,
  total_cents INTEGER NOT NULL DEFAULT 0,
  classifier_calls INTEGER NOT NULL DEFAULT 0,
  reply_calls INTEGER NOT NULL DEFAULT 0,
  budget_warning_sent INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_message TEXT NOT NULL,
  source_message_id TEXT,
  extracted_fact TEXT NOT NULL,
  category TEXT,
  confidence INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMP,
  rejected_at TIMESTAMP,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_entries(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);

CREATE INDEX IF NOT EXISTS idx_contacts_category ON contacts(category);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_whatsapp_id ON messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
