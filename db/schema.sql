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
  assigned_big_project_owner TEXT,
  deferred_handoff TEXT,
  deferred_handoff_at TEXT,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active TIMESTAMP,
  notes TEXT
);

-- Owner-alert routing state. Single-row key/value for the Category 2
-- round-robin (last_big_project_assignee = 'charbel' | 'patrick').
CREATE TABLE IF NOT EXISTS routing_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
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
  last_assistant_reply_at TIMESTAMP,
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

CREATE TABLE IF NOT EXISTS catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  size_kw REAL,
  capacity_kwh REAL,
  phase TEXT,
  type TEXT,
  price_ngn INTEGER,
  in_stock INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS warehouse_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  price_ngn INTEGER,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  datasheet_filename TEXT,
  datasheet_path TEXT,
  datasheet_mime TEXT,
  datasheet_size_bytes INTEGER,
  datasheet_meta_media_id TEXT,
  datasheet_meta_uploaded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  location TEXT NOT NULL CHECK (location IN ('abuja', 'lagos')),
  state TEXT NOT NULL DEFAULT 'out_of_stock' CHECK (state IN ('in_stock', 'out_of_stock', 'incoming')),
  quantity INTEGER NOT NULL DEFAULT 0,
  coming_note TEXT,
  eta_date TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES warehouse_items(id) ON DELETE CASCADE,
  UNIQUE(item_id, location)
);

CREATE INDEX IF NOT EXISTS idx_warehouse_items_section ON warehouse_items(section);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_item ON warehouse_stock(item_id);

CREATE TABLE IF NOT EXISTS datasheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  meta_media_id TEXT,
  meta_media_uploaded_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse_item_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  caption TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  meta_media_id TEXT,
  meta_media_uploaded_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES warehouse_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_datasheets_status ON datasheets(status);
CREATE INDEX IF NOT EXISTS idx_catalog_section ON catalog_items(section);
CREATE INDEX IF NOT EXISTS idx_warehouse_item_photos_item ON warehouse_item_photos(item_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_warehouse_item_photos_status ON warehouse_item_photos(status);

CREATE INDEX IF NOT EXISTS idx_contacts_category ON contacts(category);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_whatsapp_id ON messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
